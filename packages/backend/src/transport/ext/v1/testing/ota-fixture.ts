// Test-only: a hosted OTA app over pglite and the filesystem store, with the /v1 and
// storage routes mounted, a secret `ota:write` key, the signing fixture certificate
// registered, and helpers that publish the way the CLI does. Not imported by production code.
import { randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { OtaPlatforms } from '@mocco/common/ota-hosting';
import { AppPlatforms } from '@mocco/common/project';
import { Hono } from 'hono';
import { expect } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createApprovalService } from '@backend/domain/governance/instance';
import { createOtaDomain } from '@backend/domain/ota/instance';
import { TEST_SIGNING_CERT_PEM, TEST_SIGNING_KEY_PEM } from '@backend/domain/ota/testing/signing-fixtures';
import { assetHashOf } from '@backend/domain/ota/UploadService';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { ObjectRepo } from '@backend/domain/storage/repos/object.repo';
import { StorageUrlSigner } from '@backend/domain/storage/signing';
import { StorageService } from '@backend/domain/storage/StorageService';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createStorageRoutes } from '@backend/transport/ext/storage';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { JobQueue } from '@backend/domain/jobs/ports';
import type { OtaDomain } from '@backend/domain/ota/instance';
import type { OtaPlatform, UploadResponse } from '@mocco/common/ota-hosting';
import type { JWTVerifyGetKey } from 'jose';

export const ORIGIN = 'https://mocco.test';
export const API = `${ORIGIN}/api/ext/v1`;
export const RUNTIME = '1.0.0';

export interface FakeAsset {
  bytes: string;
  hash: string;
  contentType: string;
  ext: string;
}

export const assetOf = (bytes: string, contentType: string, ext: string): FakeAsset => ({
  bytes,
  hash: assetHashOf(Buffer.from(bytes)),
  contentType,
  ext,
});

export const signBody = (body: string, keyPem = TEST_SIGNING_KEY_PEM) => ({
  // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Uint8Array#toBase64 isn't in Node 22
  sig: sign('sha256', Buffer.from(body), keyPem).toString('base64'),
  keyid: 'root',
});

export const bundle = assetOf('console.log("v1")', 'application/javascript', 'bundle');
export const image = assetOf('png-bytes', 'image/png', 'png');

export interface ManifestOptions {
  createdAt?: Date;
  assetUrlBase?: string;
  id?: string;
  launch?: FakeAsset;
}

export async function createOtaFixture(options: { oidcKeys?: JWTVerifyGetKey } = {}) {
  const t: TestDb = await createTestDb();
  const root = await mkdtemp(path.join(tmpdir(), 'mocco-ota-'));
  const signer = new StorageUrlSigner('ota-test-key');
  const store = new FilesystemObjectStore({ root, baseUrl: `${ORIGIN}/api/ext/internal/storage`, signer });
  const storage = new StorageService({ objects: new ObjectRepo(t.db), store });
  const audit = new AuditService({ audit: new AuditRepo(t.db) });
  const { projects } = createProjectDomain(t.db);
  const approvals = createApprovalService(t.db, audit);
  const enqueued: { kind: string; payload: unknown }[] = [];
  // Records what finalize enqueues; tests run the verify job themselves.
  const queue = {
    enqueue: async (job: { kind: string }, payload: unknown) => {
      enqueued.push({ kind: job.kind, payload });
      return await Promise.resolve({ job: { id: randomUUID() }, created: true });
    },
    kick: () => {},
  } as unknown as JobQueue;
  const ota: OtaDomain = createOtaDomain(t.db, {
    projects,
    approvals,
    audit,
    publicApiBase: API,
    storage,
    queue,
    ...(options.oidcKeys !== undefined && { oidcKeys: options.oidcKeys }),
  });
  const apiKeys = createApiKeyService(t.db, { projects, audit });
  const app = new Hono()
    .basePath('/api/ext')
    .route(
      '/v1',
      createV1Routes({
        apiKeys,
        limiter: new MemoryRateLimiter(),
        ota: {
          uploads: ota.otaUploads,
          channels: ota.otaChannels,
          updateChecks: ota.otaUpdateChecks,
          trustPolicies: ota.otaTrustPolicies,
        },
      }),
    )
    .route('/', createStorageRoutes({ store, signer }));

  const workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
  const ownerId = expectOne(
    await t.db
      .insert(users)
      .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
      .returning(),
  ).id;
  const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
  const projectApp = await projects.addApp(workspaceId, project.id, {
    platform: AppPlatforms.reactNative,
    name: 'Acme mobile',
  });
  const otaApp = await ota.otaHosting.createApp(workspaceId, project.id, ownerId, projectApp.id);
  const appRow = await ota.otaHosting.requireApp(workspaceId, project.id, otaApp.id);
  await ota.otaSigning.add(appRow, ownerId, { certificatePem: TEST_SIGNING_CERT_PEM, keyid: 'root' });
  const created = await apiKeys.create(workspaceId, project.id, ownerId, {
    kind: ApiKeyKinds.secret,
    name: 'CI',
    scopes: [ApiScopes.otaWrite],
    expiresAt: null,
  });

  const call = async (method: string, url: string, token: string, body?: unknown) =>
    await app.fetch(
      new Request(url, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );

  const newSession = async () => {
    const response = await call('POST', `${API}/ota/apps/${otaApp.id}/upload-sessions`, created.token);
    expect(response.status).toBe(201);
    const { sessionToken } = (await response.json()) as { sessionToken: string };
    return sessionToken;
  };

  const declare = async (session: string, assets: readonly FakeAsset[], platforms: OtaPlatform[] = ['ios']) => {
    const response = await call('POST', `${API}/ota/uploads`, session, {
      runtimeVersion: RUNTIME,
      platforms,
      assets: assets.map(asset => ({
        hash: asset.hash,
        size: Buffer.byteLength(asset.bytes),
        contentType: asset.contentType,
        ext: asset.ext,
      })),
      gitSha: 'abc1234',
      message: 'Fix the login button',
    });
    expect(response.status).toBe(201);
    return (await response.json()) as UploadResponse;
  };

  const putMissing = async (declared: UploadResponse, assets: readonly FakeAsset[]) => {
    await Promise.all(
      declared.missing.map(async target => {
        const asset = assets.find(candidate => candidate.hash === target.hash);
        const response = await app.fetch(
          new Request(target.putUrl, { method: 'PUT', headers: target.headers, body: asset?.bytes ?? '' }),
        );
        expect(response.status).toBe(200);
      }),
    );
  };

  const manifestOf = (opts: ManifestOptions = {}) => {
    const base = opts.assetUrlBase ?? otaApp.assetBaseUrl;
    const launch = opts.launch ?? bundle;
    return JSON.stringify({
      id: opts.id ?? randomUUID(),
      createdAt: (opts.createdAt ?? new Date()).toISOString(),
      runtimeVersion: RUNTIME,
      launchAsset: {
        hash: launch.hash,
        key: 'bundle',
        contentType: launch.contentType,
        fileExtension: '.bundle',
        url: `${base}/${launch.hash}`,
      },
      assets: [
        {
          hash: image.hash,
          key: 'logo',
          contentType: image.contentType,
          fileExtension: '.png',
          url: `${base}/${image.hash}`,
        },
      ],
      metadata: {},
      extra: { mocco: { gitSha: 'abc1234' } },
    });
  };

  const finalize = async (session: string, releaseId: string, body: unknown) =>
    await call('POST', `${API}/ota/uploads/${releaseId}/finalize`, session, body);

  /** Session → declare → PUT → finalize a signed iOS update; returns the release id. */
  const publish = async (manifest = manifestOf(), launch = bundle) => {
    const session = await newSession();
    const declared = await declare(session, [launch, image]);
    await putMissing(declared, [launch, image]);
    const response = await finalize(session, declared.releaseId, {
      updates: [{ platform: OtaPlatforms.ios, body: manifest, signature: signBody(manifest) }],
    });
    expect(response.status).toBe(200);
    return { releaseId: declared.releaseId, declared, session, manifest };
  };

  return {
    t,
    app,
    ota,
    enqueued,
    workspaceId,
    ownerId,
    projectId: project.id,
    otaAppId: otaApp.id,
    assetBaseUrl: otaApp.assetBaseUrl,
    secretToken: created.token,
    appRow,
    call,
    newSession,
    declare,
    putMissing,
    manifestOf,
    finalize,
    publish,
    close: async () => {
      await t.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export type OtaFixture = Awaited<ReturnType<typeof createOtaFixture>>;
