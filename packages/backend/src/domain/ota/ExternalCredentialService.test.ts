import { randomBytes, randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { OtaTools } from '@mocco/common/ota';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { CredentialUnavailableError } from '@backend/domain/credential/errors';
import { createApprovalService } from '@backend/domain/governance/instance';
import {
  OtaCredentialNameTakenError,
  OtaCredentialNotFoundError,
  SecretStorageUnavailableError,
} from '@backend/domain/ota/errors';
import { createOtaDomain } from '@backend/domain/ota/instance';
import { ExternalTokenProvider } from '@backend/domain/ota/providers/external-token';
import { OtaExternalCredentialRepo } from '@backend/domain/ota/repos/ota-external-credential.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { SecretBoxError } from '@backend/infra/crypto/errors';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import { otaExternalCredentials, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { ExternalCredentialService } from '@backend/domain/ota/ExternalCredentialService';

const SECRET = 'expo-robot-token-abc123';

describe('External OTA credentials (pglite)', () => {
  let t: TestDb;
  let audit: AuditService;
  let box: SecretBox;
  let service: ExternalCredentialService;
  let workspaceId: string;
  let projectId: string;
  let userId: string;

  async function seedWorkspaceProject(handle: string) {
    const project = createProjectDomain(t.db);
    const ws = expectOne(await t.db.insert(workspaces).values({ name: handle, slug: randomUUID() }).returning()).id;
    const created = await project.projects.create(ws, { name: handle, handle });
    return { workspaceId: ws, projectId: created.id };
  }

  const provider = () =>
    new ExternalTokenProvider(OtaTools.eas, {
      credentials: new OtaExternalCredentialRepo(t.db),
      secretBox: () => box,
    });

  beforeEach(async () => {
    t = await createTestDb();
    audit = new AuditService({ audit: new AuditRepo(t.db) });
    box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
    service = createOtaDomain(t.db, {
      projects: createProjectDomain(t.db).projects,
      approvals: createApprovalService(t.db, audit),
      audit,
      secretBox: () => box,
    }).externalCredentials;
    ({ workspaceId, projectId } = await seedWorkspaceProject('acme'));
    const [user] = await t.db
      .insert(users)
      .values({ email: `${randomUUID()}@example.com`, name: 'U' })
      .returning();
    userId = expectOne(user === undefined ? [] : [user]).id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('stores a sealed secret and never returns it', async () => {
    const created = await service.create(workspaceId, projectId, userId, {
      tool: OtaTools.eas,
      name: 'acme-production',
      secret: SECRET,
    });
    expect(created).toMatchObject({ tool: 'eas', name: 'acme-production', provider: 'ota-eas' });
    expect(created.secretFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(created)).not.toContain(SECRET);
    expect(JSON.stringify(await service.list(workspaceId, projectId))).not.toContain(SECRET);

    const [row] = await t.db.select().from(otaExternalCredentials);
    expect(row?.secretSealed.startsWith('v1.k1.')).toBe(true);
    expect(row?.secretSealed).not.toContain(SECRET);

    const entries = await audit.list(workspaceId, 0n);
    expect(JSON.stringify(entries.map(entry => entry.payload))).not.toContain(SECRET);
    expect(entries.map(entry => entry.action)).toContain(AuditActions.otaCredentialCreated);
  });

  it('rejects a taken name in the workspace', async () => {
    const input = { tool: OtaTools.eas, name: 'prod', secret: SECRET };
    await service.create(workspaceId, projectId, userId, input);
    await expect(service.create(workspaceId, projectId, userId, input)).rejects.toBeInstanceOf(
      OtaCredentialNameTakenError,
    );
  });

  it('rotates and deletes, scoped to the project', async () => {
    const created = await service.create(workspaceId, projectId, userId, {
      tool: OtaTools.codepush,
      name: 'cp',
      secret: SECRET,
    });
    const rotated = await service.rotate(workspaceId, projectId, userId, created.id, 'new-secret');
    expect(rotated.secretFingerprint).not.toBe(created.secretFingerprint);
    expect(rotated.rotatedAt).not.toBeNull();

    const other = await seedWorkspaceProject('other');
    await expect(service.rotate(other.workspaceId, other.projectId, userId, created.id, 'x')).rejects.toBeInstanceOf(
      OtaCredentialNotFoundError,
    );
    await service.delete(workspaceId, projectId, userId, created.id);
    expect(await service.list(workspaceId, projectId)).toHaveLength(0);
  });

  it('fails with a domain error when secret storage is not configured', async () => {
    const unconfigured = createOtaDomain(t.db, {
      projects: createProjectDomain(t.db).projects,
      approvals: createApprovalService(t.db, audit),
      audit,
      secretBox: () => {
        throw new SecretBoxError('SECRETS_ENCRYPTION_KEYS is not set');
      },
    }).externalCredentials;
    await expect(
      unconfigured.create(workspaceId, projectId, userId, { tool: OtaTools.eas, name: 'x', secret: SECRET }),
    ).rejects.toBeInstanceOf(SecretStorageUnavailableError);
  });

  describe('the broker provider', () => {
    it("releases the secret named by the role, looked up in the run's workspace only", async () => {
      await service.create(workspaceId, projectId, userId, { tool: OtaTools.eas, name: 'prod', secret: SECRET });
      const issued = await provider().issue({ workspaceId, provider: 'ota-eas', role: 'prod', ttlSeconds: 900 });
      expect(issued).toMatchObject({ provider: 'ota-eas', role: 'prod', value: SECRET });

      const other = await seedWorkspaceProject('other');
      await expect(
        provider().issue({ workspaceId: other.workspaceId, provider: 'ota-eas', role: 'prod', ttlSeconds: 900 }),
      ).rejects.toBeInstanceOf(CredentialUnavailableError);
    });

    it("does not release another tool's credential under the same name", async () => {
      await service.create(workspaceId, projectId, userId, { tool: OtaTools.codepush, name: 'prod', secret: SECRET });
      await expect(
        provider().issue({ workspaceId, provider: 'ota-eas', role: 'prod', ttlSeconds: 900 }),
      ).rejects.toBeInstanceOf(CredentialUnavailableError);
    });

    it('refuses a sealed value copied onto another row (the AAD binds it to its row)', async () => {
      const a = await service.create(workspaceId, projectId, userId, { tool: OtaTools.eas, name: 'a', secret: SECRET });
      await service.create(workspaceId, projectId, userId, { tool: OtaTools.eas, name: 'b', secret: 'other' });
      const repo = new OtaExternalCredentialRepo(t.db);
      const rowA = await repo.getInProject(workspaceId, projectId, a.id);
      const rows = await repo.listByProject(workspaceId, projectId);
      const rowB = rows.find(row => row.name === 'b');
      await repo.updateSecret(workspaceId, rowB?.id ?? '', {
        secretSealed: rowA.secretSealed,
        secretFingerprint: rowA.secretFingerprint,
      });
      await expect(
        provider().issue({ workspaceId, provider: 'ota-eas', role: 'b', ttlSeconds: 900 }),
      ).rejects.toBeInstanceOf(CredentialUnavailableError);
    });
  });
});
