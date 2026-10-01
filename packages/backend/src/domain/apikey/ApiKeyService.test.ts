import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { AuditActions } from '@mocco/common/audit';
import { AppPlatforms } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiKeyRefusals } from '@backend/domain/apikey/ApiKeyService';
import { createApiKeyService } from '@backend/domain/apikey/instance';
import { hashToken } from '@backend/domain/apikey/tokens';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { apiKeys, auditLog, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { ApiKeyService } from '@backend/domain/apikey/ApiKeyService';

describe('ApiKeyService (pglite)', () => {
  let t: TestDb;
  let service: ApiKeyService;
  let workspaceId: string;
  let projectId: string;
  let userId: string;

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const { projects } = createProjectDomain(t.db);
    service = createApiKeyService(t.db, { projects, audit });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    await projects.addApp(workspaceId, projectId, {
      platform: AppPlatforms.web,
      name: 'Acme web',
      webOrigins: ['https://app.acme.test'],
    });
  });
  afterEach(async () => {
    await t.close();
  });

  const create = async (kind: (typeof ApiKeyKinds)[keyof typeof ApiKeyKinds], expiresAt: Date | null = null) =>
    await service.create(workspaceId, projectId, userId, {
      kind,
      name: `${kind} key`,
      scopes: [ApiScopes.flagsRead],
      expiresAt,
    });

  it('returns the token once, stores only its hash, and audits the creation', async () => {
    const { key, token } = await create(ApiKeyKinds.secret);

    expect(token).toMatch(/^mk_sec_[0-9A-Za-z]{32}$/u);
    expect(key.hint).toBe(`mk_sec_…${token.slice(-4)}`);
    const [row] = await t.db.select().from(apiKeys);
    expect(row?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(await service.list(workspaceId, projectId))).not.toContain(token);
    const audit = await t.db.select().from(auditLog);
    expect(audit.map(entry => entry.action)).toEqual([AuditActions.apiKeyCreated]);
  });

  it('authenticates a valid key as its project, without an origin', async () => {
    const { token } = await create(ApiKeyKinds.secret);

    const check = await service.authenticate(token, { origin: undefined });

    expect(check).toMatchObject({
      ok: true,
      principal: { workspaceId, projectId, kind: ApiKeyKinds.secret, scopes: [ApiScopes.flagsRead] },
    });
    const [row] = await t.db.select().from(apiKeys);
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it('refuses unknown, malformed, revoked and expired keys the same way', async () => {
    const revoked = await create(ApiKeyKinds.secret);
    await service.revoke(workspaceId, projectId, userId, revoked.key.id);
    const expired = await create(ApiKeyKinds.secret, new Date(Date.now() - 1000));
    const invalid = { ok: false, refusal: ApiKeyRefusals.invalid };

    expect(await service.authenticate(`mk_sec_${'A'.repeat(32)}`, { origin: undefined })).toEqual(invalid);
    expect(await service.authenticate('not-a-key', { origin: undefined })).toEqual(invalid);
    expect(await service.authenticate(revoked.token, { origin: undefined })).toEqual(invalid);
    expect(await service.authenticate(expired.token, { origin: undefined })).toEqual(invalid);
  });

  it('refuses a secret key from a browser', async () => {
    const { token } = await create(ApiKeyKinds.secret);

    expect(await service.authenticate(token, { origin: 'https://app.acme.test' })).toEqual({
      ok: false,
      refusal: ApiKeyRefusals.secretFromBrowser,
    });
  });

  it("accepts a publishable key only from the project's web origins (or with no origin)", async () => {
    const { token } = await create(ApiKeyKinds.publishable);

    const accepted = await Promise.all(
      ['https://app.acme.test', 'https://APP.acme.test:443', undefined].map(
        async origin => await service.authenticate(token, { origin }),
      ),
    );
    expect(accepted.map(check => check.ok)).toEqual([true, true, true]);
    expect(await service.authenticate(token, { origin: 'https://evil.test' })).toEqual({
      ok: false,
      refusal: ApiKeyRefusals.originNotAllowed,
    });
    expect(await service.authenticate(token, { origin: 'null' })).toEqual({
      ok: false,
      refusal: ApiKeyRefusals.originNotAllowed,
    });
  });

  it('revokes once and audits it', async () => {
    const { key } = await create(ApiKeyKinds.publishable);

    await service.revoke(workspaceId, projectId, userId, key.id);
    await service.revoke(workspaceId, projectId, userId, key.id);

    const audit = await t.db.select().from(auditLog);
    expect(audit.map(entry => entry.action)).toEqual([AuditActions.apiKeyCreated, AuditActions.apiKeyRevoked]);
    await expect(service.revoke(workspaceId, projectId, userId, randomUUID())).rejects.toThrow(/not found/u);
  });
});
