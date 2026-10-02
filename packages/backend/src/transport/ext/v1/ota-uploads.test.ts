import { randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { AuditActions } from '@mocco/common/audit';
import { OtaPlatforms, OtaReleaseStatuses } from '@mocco/common/ota-hosting';
import { AppPlatforms } from '@mocco/common/project';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createApprovalService } from '@backend/domain/governance/instance';
import { createOtaDomain } from '@backend/domain/ota/instance';
import {
  OTHER_SIGNING_KEY_PEM,
  TEST_SIGNING_CERT_PEM,
  TEST_SIGNING_KEY_PEM,
} from '@backend/domain/ota/testing/signing-fixtures';
import { assetHashOf } from '@backend/domain/ota/UploadService';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { ObjectRepo } from '@backend/domain/storage/repos/object.repo';
import { StorageUrlSigner } from '@backend/domain/storage/signing';
import { StorageService } from '@backend/domain/storage/StorageService';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  otaChannelHeads,
  otaReleases,
  otaSignedDirectives,
  otaUpdates,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createStorageRoutes } from '@backend/transport/ext/storage';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { JobQueue } from '@backend/domain/jobs/ports';
import type { OtaDomain } from '@backend/domain/ota/instance';
import type { UploadResponse } from '@mocco/common/ota-hosting';

const ORIGIN = 'https://mocco.test';
const API = `${ORIGIN}/api/ext/v1`;
const RUNTIME = '1.0.0';

interface FakeAsset {
  bytes: string;
  hash: string;
  contentType: string;
  ext: string;
}

const assetOf = (bytes: string, contentType: string, ext: string): FakeAsset => ({
  bytes,
  hash: assetHashOf(Buffer.from(bytes)),
  contentType,
  ext,
});

const signBody = (body: string, keyPem = TEST_SIGNING_KEY_PEM) => ({
  // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Uint8Array#toBase64 isn't in Node 22
  sig: sign('sha256', Buffer.from(body), keyPem).toString('base64'),
  keyid: 'root',
});

describe('/v1/ota uploads (pglite + filesystem store)', () => {
  let t: TestDb;
  let root: string;
  let app: Hono;
  let ota: OtaDomain;
  let workspaceId: string;
  let otaAppId: string;
  let assetBaseUrl: string;
  let secretToken: string;
  let enqueued: { kind: string; payload: unknown }[];
  let ownerId: string;
  let projectId: string;

  const bundle = assetOf('console.log("v1")', 'application/javascript', 'bundle');
  const image = assetOf('png-bytes', 'image/png', 'png');

  const call = async (method: string, url: string, token: string, body?: unknown) =>
    await app.fetch(
      new Request(url, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );

  const newSession = async () => {
    const response = await call('POST', `${API}/ota/apps/${otaAppId}/upload-sessions`, secretToken);
    expect(response.status).toBe(201);
    const { sessionToken } = (await response.json()) as { sessionToken: string };
    return sessionToken;
  };

  const declare = async (session: string, assets: readonly FakeAsset[]) => {
    const response = await call('POST', `${API}/ota/uploads`, session, {
      runtimeVersion: RUNTIME,
      platforms: [OtaPlatforms.ios],
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

  const manifestOf = (opts: { createdAt?: Date; assetUrlBase?: string; id?: string } = {}) => {
    const base = opts.assetUrlBase ?? assetBaseUrl;
    return JSON.stringify({
      id: opts.id ?? randomUUID(),
      createdAt: (opts.createdAt ?? new Date()).toISOString(),
      runtimeVersion: RUNTIME,
      launchAsset: {
        hash: bundle.hash,
        key: 'bundle',
        contentType: bundle.contentType,
        fileExtension: '.bundle',
        url: `${base}/${bundle.hash}`,
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
  const publish = async (manifest = manifestOf()) => {
    const session = await newSession();
    const declared = await declare(session, [bundle, image]);
    await putMissing(declared, [bundle, image]);
    const response = await finalize(session, declared.releaseId, {
      updates: [{ platform: OtaPlatforms.ios, body: manifest, signature: signBody(manifest) }],
    });
    expect(response.status).toBe(200);
    return { releaseId: declared.releaseId, declared, session };
  };

  beforeEach(async () => {
    t = await createTestDb();
    root = await mkdtemp(path.join(tmpdir(), 'mocco-ota-upload-'));
    const signer = new StorageUrlSigner('ota-upload-test-key');
    const store = new FilesystemObjectStore({ root, baseUrl: `${ORIGIN}/api/ext/internal/storage`, signer });
    const storage = new StorageService({ objects: new ObjectRepo(t.db), store });
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const { projects } = createProjectDomain(t.db);
    const approvals = createApprovalService(t.db, audit);
    enqueued = [];
    // Records what finalize enqueues; tests run the verify job themselves.
    const queue = {
      enqueue: async (job: { kind: string }, payload: unknown) => {
        enqueued.push({ kind: job.kind, payload });
        return await Promise.resolve({ job: { id: randomUUID() }, created: true });
      },
      kick: () => {},
    } as unknown as JobQueue;
    ota = createOtaDomain(t.db, { projects, approvals, audit, publicApiBase: API, storage, queue });
    const apiKeys = createApiKeyService(t.db, { projects, audit });
    app = new Hono()
      .basePath('/api/ext')
      .route('/v1', createV1Routes({ apiKeys, limiter: new MemoryRateLimiter(), ota: { uploads: ota.otaUploads } }))
      .route('/', createStorageRoutes({ store, signer }));

    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const userId = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    ownerId = userId;
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    const projectApp = await projects.addApp(workspaceId, project.id, {
      platform: AppPlatforms.reactNative,
      name: 'Acme mobile',
    });
    const otaApp = await ota.otaHosting.createApp(workspaceId, project.id, userId, projectApp.id);
    otaAppId = otaApp.id;
    assetBaseUrl = otaApp.assetBaseUrl;
    projectId = project.id;
    const otaRow = await ota.otaHosting.requireApp(workspaceId, project.id, otaApp.id);
    await ota.otaSigning.add(otaRow, userId, { certificatePem: TEST_SIGNING_CERT_PEM, keyid: 'root' });
    const created = await apiKeys.create(workspaceId, project.id, userId, {
      kind: ApiKeyKinds.secret,
      name: 'CI',
      scopes: [ApiScopes.otaWrite],
      expiresAt: null,
    });
    secretToken = created.token;
  });
  afterEach(async () => {
    await t.close();
    await rm(root, { recursive: true, force: true });
  });

  it('uploads, verifies and readies a signed release, and audits it with the git SHA and principal', async () => {
    const { releaseId, declared } = await publish();

    expect(declared.assetBaseUrl).toBe(`${API}/ota/apps/${otaAppId}/assets`);
    expect(declared.missing.map(target => target.hash)).toHaveLength(2);
    expect(declared.missing.map(target => target.hash)).toEqual(expect.arrayContaining([bundle.hash, image.hash]));
    expect(enqueued).toEqual([{ kind: 'ota.verifyAssets', payload: { releaseId } }]);
    const [release] = await t.db.select().from(otaReleases);
    expect(release?.status).toBe(OtaReleaseStatuses.verifying);

    expect(await ota.otaUploads.verifyAssets(releaseId)).toBe(OtaReleaseStatuses.ready);

    const [update] = await t.db.select().from(otaUpdates);
    expect(update?.totalBytes).toBe(Buffer.byteLength(bundle.bytes) + Buffer.byteLength(image.bytes));
    const audit = await t.db.select().from(auditLog);
    const uploaded = audit.find(entry => entry.action === AuditActions.otaReleaseUploaded);
    expect(uploaded?.payload).toMatchObject({ gitSha: 'abc1234', principal: expect.stringMatching(/^apikey:/u) });
  });

  it('asks for zero bytes when every asset is already stored', async () => {
    const first = await publish();
    await ota.otaUploads.verifyAssets(first.releaseId);

    const session = await newSession();
    const declared = await declare(session, [bundle, image]);

    expect(declared.missing).toEqual([]);
  });

  it('rejects a far-future createdAt, a foreign asset URL and a bad signature, and stores nothing', async () => {
    const session = await newSession();
    const declared = await declare(session, [bundle, image]);
    await putMissing(declared, [bundle, image]);
    const attempt = async (manifest: string, keyPem = TEST_SIGNING_KEY_PEM) => {
      const response = await finalize(session, declared.releaseId, {
        updates: [{ platform: OtaPlatforms.ios, body: manifest, signature: signBody(manifest, keyPem) }],
      });
      expect(response.status).toBe(400);
      return ((await response.json()) as { detail: string }).detail;
    };

    expect(await attempt(manifestOf({ createdAt: new Date(Date.now() + 60 * 60 * 1000) }))).toMatch(
      /more than 10 minutes ahead/u,
    );
    expect(await attempt(manifestOf({ assetUrlBase: 'https://evil.test/assets' }))).toMatch(
      /asset URLs must be https:\/\/mocco\.test/u,
    );
    expect(await attempt(manifestOf(), OTHER_SIGNING_KEY_PEM)).toMatch(/signature doesn't verify/u);
    const unsigned = await finalize(session, declared.releaseId, {
      updates: [{ platform: OtaPlatforms.ios, body: manifestOf() }],
    });
    expect(((await unsigned.json()) as { detail: string }).detail).toMatch(/requires signed updates/u);
    expect(await t.db.select().from(otaUpdates)).toEqual([]);

    // Fixed, the same release finalizes.
    const manifest = manifestOf();
    const fixed = await finalize(session, declared.releaseId, {
      updates: [{ platform: OtaPlatforms.ios, body: manifest, signature: signBody(manifest) }],
    });
    expect(fixed.status).toBe(200);
    const again = await finalize(session, declared.releaseId, {
      updates: [{ platform: OtaPlatforms.ios, body: manifest, signature: signBody(manifest) }],
    });
    expect(again.status).toBe(409);
  });

  it('fails a release whose stored bytes no longer match, and asks for them again', async () => {
    const { releaseId, declared } = await publish();
    // Overwrite the bundle's bytes in place, behind Mocco's back.
    const target = declared.missing.find(candidate => candidate.hash === bundle.hash);
    await app.fetch(
      new Request(target?.putUrl ?? '', { method: 'PUT', headers: target?.headers, body: 'tampered!!!!!!!!!' }),
    );

    expect(await ota.otaUploads.verifyAssets(releaseId)).toBe(OtaReleaseStatuses.failed);

    const audit = await t.db.select().from(auditLog);
    const actions = audit.map(entry => entry.action);
    expect(actions).toContain(AuditActions.otaReleaseFailed);
    const next = await declare(await newSession(), [bundle, image]);
    expect(next.missing.map(missing => missing.hash)).toEqual([bundle.hash]);
  });

  it('accepts a pre-signed republish of the channel head and a rollBackToEmbedded directive', async () => {
    const first = await publish();
    await ota.otaUploads.verifyAssets(first.releaseId);
    const headUpdate = expectOne(await t.db.select().from(otaUpdates));
    const appRow = await ota.otaHosting.requireApp(workspaceId, projectId, otaAppId);
    const channel = await ota.otaHosting.createChannel(appRow, ownerId, { name: 'production', policy: null });
    await t.db.insert(otaChannelHeads).values({
      workspaceId,
      channelId: channel.id,
      platform: OtaPlatforms.ios,
      runtimeVersion: RUNTIME,
      activeUpdateId: headUpdate.id,
      rolloutSalt: 'salt',
    });

    const session = await newSession();
    const declared = await declare(session, [bundle, image]);
    expect(declared.missing).toEqual([]);
    expect(declared.rollbackTargets).toEqual([
      { channel: 'production', platform: OtaPlatforms.ios, updateId: headUpdate.id, manifest: headUpdate.manifestBody },
    ]);
    const createdAt = new Date();
    const manifest = manifestOf({ createdAt });
    const later = new Date(createdAt.getTime() + 1).toISOString();
    const [target] = declared.rollbackTargets;
    const republishOf = (at: string) =>
      JSON.stringify({ ...(JSON.parse(target?.manifest ?? '{}') as object), id: randomUUID(), createdAt: at });
    const directive = JSON.stringify({ type: 'rollBackToEmbedded', parameters: { commitTime: later } });
    const body = (republish: string) => ({
      updates: [{ platform: OtaPlatforms.ios, body: manifest, signature: signBody(manifest) }],
      republishes: [
        { platform: OtaPlatforms.ios, targetUpdateId: headUpdate.id, body: republish, signature: signBody(republish) },
      ],
      directives: [{ platform: OtaPlatforms.ios, body: directive, signature: signBody(directive) }],
    });

    const stale = await finalize(session, declared.releaseId, body(republishOf(createdAt.toISOString())));
    expect(((await stale.json()) as { detail: string }).detail).toMatch(/must be later than the release's update/u);
    const response = await finalize(session, declared.releaseId, body(republishOf(later)));

    expect(response.status).toBe(200);
    const { updates } = (await response.json()) as { updates: Record<string, string> };
    const rows = await t.db.select().from(otaUpdates);
    const republish = rows.find(row => row.kind === 'republish');
    expect(republish).toMatchObject({ contentOfUpdateId: headUpdate.id, supersedesUpdateId: updates.ios });
    const directives = await t.db.select().from(otaSignedDirectives);
    expect(directives).toMatchObject([{ type: 'rollBackToEmbedded', supersedesUpdateId: updates.ios }]);
  });

  it('fails releases abandoned before finalize once their session has expired', async () => {
    const session = await newSession();
    const declared = await declare(session, [bundle]);
    await t.db
      .update(otaReleases)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(otaReleases.id, declared.releaseId));

    expect(await ota.otaUploads.pruneSessions()).toEqual({ sessions: 0, abandoned: 1 });
    const [release] = await t.db.select().from(otaReleases);
    expect(release?.status).toBe(OtaReleaseStatuses.failed);
  });

  it('refuses unknown sessions, apps of other projects and a second release per session', async () => {
    const unknown = await call('POST', `${API}/ota/uploads`, 'mk_ups_nope', {});
    expect(unknown.status).toBe(401);
    const foreign = await call('POST', `${API}/ota/apps/${randomUUID()}/upload-sessions`, secretToken);
    expect(foreign.status).toBe(404);

    const session = await newSession();
    await declare(session, [bundle]);
    const second = await call('POST', `${API}/ota/uploads`, session, {
      runtimeVersion: RUNTIME,
      platforms: [OtaPlatforms.ios],
      assets: [{ hash: bundle.hash, size: 1, contentType: bundle.contentType, ext: 'bundle' }],
    });
    expect(second.status).toBe(409);
  });
});
