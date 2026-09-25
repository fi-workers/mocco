import { randomUUID } from 'node:crypto';

import { ExecutorIds } from '@mocco/common/execution';
import { versionCheckResponseSchema } from '@mocco/common/ota';
import { AppPlatforms } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { CredentialBroker } from '@backend/domain/credential/CredentialBroker';
import { StubCredentialProvider } from '@backend/domain/credential/providers/stub';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import { createApprovalService } from '@backend/domain/governance/instance';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { createOtaDomain } from '@backend/domain/ota/instance';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createExtApp } from '@backend/transport/ext/app';

import type { OtaDomain } from '@backend/domain/ota/instance';
import type { Hono } from 'hono';

const CALLBACK_URL = 'http://localhost:3100/api/ext/callback';
const checkUrl = (appId: string, query: string) =>
  `https://www.mocco.work/api/ext/v1/apps/${appId}/version-check?${query}`;

describe('GET /api/ext/v1/apps/:appId/version-check (pglite)', () => {
  let t: TestDb;
  let ota: OtaDomain;
  let app: Hono;
  let iosAppId: string;
  let androidAppId: string;

  async function check(appId: string, query: string, headers: Record<string, string> = {}) {
    const response = await app.fetch(new Request(checkUrl(appId, query), { headers }));
    return response;
  }

  async function statusCode(appId: string, query: string) {
    const response = await check(appId, query);
    return response.status;
  }

  async function checkBody(appId: string, query: string) {
    const response = await check(appId, query);
    return versionCheckResponseSchema.parse(await response.json());
  }

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const project = createProjectDomain(t.db);
    ota = createOtaDomain(t.db, { projects: project.projects, approvals: createApprovalService(t.db, audit), audit });
    app = createExtApp({
      auth: new AuthService(createProvider(t.db, { secret: 'test-secret-not-for-prod' })),
      runs: new RunService({
        runs: new RunRepo(t.db),
        steps: new RunStepRepo(t.db),
        events: new RunEventRepo(t.db),
        runGates: new RunGateRepo(t.db),
        resumes: new ResumeRepo(t.db),
        commits: new CommitRepo(t.db),
        configs: new CommitConfigRepo(t.db),
        executors: new Map([[ExecutorIds.generic, new FakeExecutor()]]),
        callbackUrl: CALLBACK_URL,
        audit,
        waitUntil: () => {
          /* not exercised */
        },
      }),
      broker: new CredentialBroker({
        runs: new RunRepo(t.db),
        steps: new RunStepRepo(t.db),
        runGates: new RunGateRepo(t.db),
        configs: new CommitConfigRepo(t.db),
        commits: new CommitRepo(t.db),
        grants: new CredentialGrantRepo(t.db),
        provider: new StubCredentialProvider(),
        audit,
      }),
      versionChecks: ota.versionChecks,
      callbackUrl: CALLBACK_URL,
      postJson: async () => {
        /* not exercised */
      },
      webhookSecret: undefined,
      waitUntil: () => {
        /* not exercised */
      },
    });

    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const [user] = await t.db
      .insert(users)
      .values({ email: `${randomUUID()}@example.com`, name: 'U' })
      .returning();
    const userId = expectOne(user === undefined ? [] : [user]).id;
    const created = await project.projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    const ios = await project.projects.addApp(workspaceId, created.id, {
      platform: AppPlatforms.ios,
      name: 'iOS',
      bundleId: 'com.acme',
      storeAppId: '123456789',
    });
    const android = await project.projects.addApp(workspaceId, created.id, {
      platform: AppPlatforms.android,
      name: 'Android',
      bundleId: 'com.acme.android',
    });
    iosAppId = ios.id;
    androidAppId = android.id;
    const rules = {
      minSupportedVersion: '2.0.0',
      recommendedVersion: '2.4.0',
      blockedVersions: ['2.3.1'],
      messages: {
        en: { title: 'Update', body: 'Please update.', action: 'Update' },
        fr: { title: 'Mise à jour', body: 'Veuillez mettre à jour.', action: 'Mettre à jour' },
      },
      storeUrl: null,
      softPromptIntervalHours: 48,
      approvalPolicy: null,
    };
    await ota.versionPolicies.change(workspaceId, created.id, ios.id, userId, { rules, storeLiveAttested: true });
    await ota.versionPolicies.change(workspaceId, created.id, android.id, userId, { rules, storeLiveAttested: true });
  });
  afterEach(async () => {
    await t.close();
  });

  it('answers hard, soft and ok with the store link', async () => {
    expect(await checkBody(iosAppId, 'version=1.9.0')).toMatchObject({
      status: 'hard',
      storeUrl: 'https://apps.apple.com/app/id123456789',
      promptIntervalHours: 48,
      revision: 1,
    });
    expect(await checkBody(iosAppId, 'version=2.3.1')).toHaveProperty('status', 'hard');
    expect(await checkBody(iosAppId, 'version=2.3')).toHaveProperty('status', 'soft');
    expect(await checkBody(iosAppId, 'version=2.4.0')).toMatchObject({ status: 'ok', message: null });
    expect(await checkBody(androidAppId, 'version=1.0')).toHaveProperty(
      'storeUrl',
      'https://play.google.com/store/apps/details?id=com.acme.android',
    );
  });

  it('falls back from the exact locale to its language, then to en', async () => {
    expect(await checkBody(iosAppId, 'version=1.0&locale=fr-CA')).toHaveProperty('message.title', 'Mise à jour');
    expect(await checkBody(iosAppId, 'version=1.0&locale=ja')).toHaveProperty('message.title', 'Update');
    expect(await checkBody(iosAppId, 'version=1.0')).toHaveProperty('message.title', 'Update');
  });

  it('answers ok for an unknown app, so a misconfigured app never locks users out', async () => {
    expect(await checkBody(randomUUID(), 'version=1.0')).toMatchObject({ status: 'ok', revision: 0 });
  });

  it('rejects a malformed version, locale or app id with 400', async () => {
    expect(await statusCode(iosAppId, 'version=2.3.1-beta')).toBe(400);
    expect(await statusCode(iosAppId, 'version=2.3&locale=<script>')).toBe(400);
    expect(await statusCode('not-a-uuid', 'version=2.3')).toBe(400);
    expect(await statusCode(iosAppId, '')).toBe(400);
  });

  it('is cacheable and answers 304 for a matching ETag', async () => {
    const first = await check(iosAppId, 'version=2.3');
    expect(first.headers.get('cache-control')).toContain('max-age=60');
    expect(first.headers.get('access-control-allow-origin')).toBe('*');
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');

    const again = await check(iosAppId, 'version=2.3', { 'if-none-match': etag });
    expect(again.status).toBe(304);
    const other = await check(iosAppId, 'version=1.0', { 'if-none-match': etag });
    expect(other.status).toBe(200);
  });
});
