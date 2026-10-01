import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { ChangesetConflictError, FlagKeyTakenError, ProtectedEnvironmentError } from '@backend/domain/flags/errors';
import { FlagService } from '@backend/domain/flags/FlagService';
import { flagdValidator } from '@backend/domain/flags/testing/flagd-schema';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { flagEnvironments, flagRulesetSnapshots, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

describe('FlagService (pglite)', () => {
  let t: TestDb;
  let audit: AuditService;
  let service: FlagService;
  let workspaceId: string;
  let projectId: string;
  let userId: string;

  beforeEach(async () => {
    t = await createTestDb();
    audit = new AuditService({ audit: new AuditRepo(t.db) });
    service = new FlagService({ db: t.db, audit });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com` })
        .returning(),
    ).id;
  });
  afterEach(async () => {
    await t.close();
  });

  const snapshots = async (environmentId: string) =>
    await t.db
      .select()
      .from(flagRulesetSnapshots)
      .where(eq(flagRulesetSnapshots.environmentId, environmentId))
      .orderBy(flagRulesetSnapshots.version);

  it('adds a new flag disabled to every environment, and existing flags to a new environment', async () => {
    const staging = await service.createEnvironment(workspaceId, projectId, userId, {
      key: 'staging',
      name: 'Staging',
    });
    await service.createBooleanFlag(workspaceId, projectId, userId, {
      key: 'new-checkout',
      description: null,
      lifecycle: 'temporary',
    });
    const production = await service.createEnvironment(workspaceId, projectId, userId, {
      key: 'production',
      name: 'Production',
    });

    const [listed] = await service.listFlags(workspaceId, projectId);
    expect(listed?.configs).toHaveLength(2);
    expect(listed?.configs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ environmentId: staging.id, enabled: false }),
        expect.objectContaining({ environmentId: production.id, enabled: false }),
      ]),
    );
    const [stagingRows, productionRows] = [await snapshots(staging.id), await snapshots(production.id)];
    expect([stagingRows.map(row => row.version), productionRows.map(row => row.version)]).toEqual([
      [0, 1],
      [0, 1],
    ]);
    const ruleset = await service.ruleset(workspaceId, projectId, production.id);
    expect(ruleset.document).toMatchObject({ flags: { 'new-checkout': { state: 'DISABLED' } } });
  });

  it('applies a changeset: bumps the version, writes a valid snapshot and an audited diff', async () => {
    const env = await service.createEnvironment(workspaceId, projectId, userId, { key: 'staging', name: 'Staging' });
    await service.createBooleanFlag(workspaceId, projectId, userId, {
      key: 'new-checkout',
      description: null,
      lifecycle: 'temporary',
    });

    const changeset = await service.applyChangeset(workspaceId, projectId, userId, {
      environmentId: env.id,
      baseVersion: 1,
      ops: [{ op: 'set_enabled', flagKey: 'new-checkout', enabled: true }],
      reason: 'launch',
    });

    expect(changeset).toMatchObject({ state: 'applied', baseVersion: 1, appliedVersion: 2, source: 'ui' });
    const ruleset = await service.ruleset(workspaceId, projectId, env.id);
    expect(ruleset.version).toBe(2);
    const validate = await flagdValidator();
    expect(validate(ruleset.document)).toBe(true);
    expect(ruleset.document).toMatchObject({ flags: { 'new-checkout': { state: 'ENABLED', defaultVariant: 'on' } } });
    const entries = await audit.list(workspaceId, 0n);
    const applied = entries.findLast(entry => entry.action === AuditActions.flagChangesetApplied);
    expect(applied?.payload).toMatchObject({
      version: 2,
      diff: [{ flagKey: 'new-checkout', field: 'enabled', before: false, after: true }],
    });
    expect(await audit.verify(workspaceId)).toMatchObject({ intact: true });
    const history = await service.history(workspaceId, projectId, env.id);
    expect(history.map(row => row.appliedVersion)).toEqual([2, 1]);
  });

  it('refuses a changeset written against an older version', async () => {
    const env = await service.createEnvironment(workspaceId, projectId, userId, { key: 'staging', name: 'Staging' });
    await service.createBooleanFlag(workspaceId, projectId, userId, {
      key: 'a',
      description: null,
      lifecycle: 'temporary',
    });
    const toggle = async (isEnabled: boolean) =>
      await service.applyChangeset(workspaceId, projectId, userId, {
        environmentId: env.id,
        baseVersion: 1,
        ops: [{ op: 'set_enabled', flagKey: 'a', enabled: isEnabled }],
        reason: null,
      });

    const results = await Promise.allSettled([toggle(true), toggle(true)]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ChangesetConflictError);
    const rows = await snapshots(env.id);
    expect(rows.map(row => row.version)).toEqual([0, 1, 2]);
  });

  it('refuses duplicate keys and ungated changes to a protected environment', async () => {
    const env = await service.createEnvironment(workspaceId, projectId, userId, { key: 'staging', name: 'Staging' });
    await service.createBooleanFlag(workspaceId, projectId, userId, {
      key: 'a',
      description: null,
      lifecycle: 'temporary',
    });

    await expect(
      service.createEnvironment(workspaceId, projectId, userId, { key: 'staging', name: 'Again' }),
    ).rejects.toThrow(FlagKeyTakenError);
    await expect(
      service.createBooleanFlag(workspaceId, projectId, userId, {
        key: 'a',
        description: null,
        lifecycle: 'temporary',
      }),
    ).rejects.toThrow(FlagKeyTakenError);
    await t.db
      .update(flagEnvironments)
      .set({ changeGate: { resume: [{ role: 'release', count: 1 }], prevent_self: true, reason_required: false } })
      .where(eq(flagEnvironments.id, env.id));
    await expect(
      service.applyChangeset(workspaceId, projectId, userId, {
        environmentId: env.id,
        baseVersion: 1,
        ops: [{ op: 'set_enabled', flagKey: 'a', enabled: true }],
        reason: null,
      }),
    ).rejects.toThrow(ProtectedEnvironmentError);
  });
});
