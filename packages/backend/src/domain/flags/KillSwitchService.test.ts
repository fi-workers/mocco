import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { FlagdCore } from '@openfeature/flagd-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFlagsDomain } from '@backend/domain/flags/compose';
import { InvalidChangeError, KillNotAllowedError } from '@backend/domain/flags/errors';
import { createApprovalService } from '@backend/domain/governance/instance';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FlagsDomain } from '@backend/domain/flags/compose';
import type { ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { GateRequirements } from '@mocco/common/governance';

const gate: GateRequirements = { resume: [{ role: 'release', count: 1 }], prevent_self: true, reason_required: false };

describe('KillSwitchService (pglite)', () => {
  let t: TestDb;
  let audit: AuditService;
  let approvals: ApprovalService;
  let domain: FlagsDomain;
  let workspaceId: string;
  let projectId: string;
  let environmentId: string;
  let owner: string;

  async function seedUser(...roleNames: string[]): Promise<string> {
    const userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test` })
        .returning(),
    ).id;
    const roles = new RoleRepo(t.db);
    await roleNames.reduce(async (previous, name) => {
      await previous;
      const existing = await roles.listByWorkspace(workspaceId);
      const role = existing.find(candidate => candidate.name === name) ?? (await roles.create({ workspaceId, name }));
      await new RoleMembershipRepo(t.db).add({ workspaceId, roleId: role.id, userId });
    }, Promise.resolve());
    return userId;
  }
  const kill = async (by: string, reason = 'Checkout errors spiking') =>
    await domain.flagKillSwitch.kill(workspaceId, projectId, by, { environmentId, flagKey: 'checkout', reason });
  const ruleset = async () => await domain.flags.ruleset(workspaceId, projectId, environmentId);

  beforeEach(async () => {
    t = await createTestDb();
    audit = new AuditService({ audit: new AuditRepo(t.db) });
    approvals = createApprovalService(t.db, audit);
    domain = createFlagsDomain(t.db, { audit, approvals });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    owner = await seedUser('release', 'oncall');
    const environment = await domain.flags.createEnvironment(workspaceId, projectId, owner, {
      key: 'production',
      name: 'Production',
    });
    environmentId = environment.id;
    await domain.flags.createBooleanFlag(workspaceId, projectId, owner, {
      key: 'checkout',
      description: null,
      lifecycle: 'temporary',
    });
    // On for pro users and everyone else: what the kill must override.
    await domain.flags.applyChangeset(workspaceId, projectId, owner, {
      environmentId,
      baseVersion: 1,
      ops: [
        { op: 'set_enabled', flagKey: 'checkout', enabled: true },
        {
          op: 'set_rules',
          flagKey: 'checkout',
          rules: [{ clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }], serve: { variant: 'on' } }],
        },
      ],
      reason: null,
    });
    await domain.flagGovernance.setChangeGate(workspaceId, projectId, owner, { environmentId, gate });
  });
  afterEach(async () => {
    await t.close();
  });

  it('kills at once on a protected environment, audited with actor and reason, and opens a review', async () => {
    const oncall = await seedUser('oncall');

    const { changeset, reviewRequestId } = await kill(oncall);
    const { document, version } = await ruleset();

    expect(changeset).toMatchObject({
      state: 'applied',
      source: 'kill',
      reason: 'Checkout errors spiking',
      proposedByUserId: oncall,
    });
    expect(version).toBe(3);
    expect(document).toMatchObject({ flags: { checkout: { state: 'ENABLED', defaultVariant: 'off', targeting: {} } } });
    const entries = await audit.list(workspaceId, 0n);
    expect(entries.find(entry => entry.action === AuditActions.flagKilled)).toMatchObject({
      actorUserId: oncall,
      payload: { flagKey: 'checkout', reason: 'Checkout errors spiking', reviewRequestId },
    });
    const review = await approvals.get(workspaceId, reviewRequestId ?? '');
    expect(review.request).toMatchObject({ kind: 'review', state: 'pending', subjectType: 'flags.kill' });
    await expect(kill(oncall)).rejects.toThrow(InvalidChangeError);
  });

  it('refuses someone outside the kill roles, and a kill without a reason', async () => {
    await domain.flagKillSwitch.setKillRoles(workspaceId, projectId, owner, { environmentId, roles: ['oncall'] });
    const outsider = await seedUser('release');

    await expect(kill(outsider)).rejects.toThrow(KillNotAllowedError);
    await expect(kill(owner, ' '.repeat(3))).rejects.toThrow(/Say why/u);
    await expect(kill(owner)).resolves.toMatchObject({ changeset: { state: 'applied' } });
  });

  it('serves the off variant even to a flagd client that ignores Mocco metadata', async () => {
    await kill(owner);
    const { document } = await ruleset();
    const flagd = new FlagdCore();
    flagd.setConfigurations(JSON.stringify(document));

    const forPro = flagd.resolveBooleanEvaluation('checkout', true, { targetingKey: 'u1', plan: 'pro' });
    const forAnyone = flagd.resolveBooleanEvaluation('checkout', true, { targetingKey: 'u2' });

    expect([forPro.value, forAnyone.value]).toEqual([false, false]);
    expect(forPro.variant).toBe('off');
  });

  it('needs the gate to restore, and audits the restore once approved', async () => {
    await kill(owner);
    const release = await seedUser('release');
    const { currentVersion } = expectOne(await domain.flags.listEnvironments(workspaceId, projectId));

    const proposed = await domain.flags.applyChangeset(workspaceId, projectId, owner, {
      environmentId,
      baseVersion: currentVersion,
      ops: [{ op: 'restore', flagKey: 'checkout' }],
      reason: 'Fixed in 2.4.1',
    });
    const stillKilled = await ruleset();
    const restored = await domain.flagGovernance.vote(workspaceId, projectId, release, {
      changesetId: proposed.changeset.id,
      contentHash: proposed.changeset.contentHash,
      decision: 'approve',
    });
    const after = await ruleset();

    expect(proposed.outcome).toBe('pending_approval');
    expect(stillKilled.document).toMatchObject({ flags: { checkout: { defaultVariant: 'off' } } });
    expect(restored.state).toBe('applied');
    expect(after.document).toMatchObject({
      flags: { checkout: { defaultVariant: 'on', metadata: { 'mocco.killed': false } } },
    });
    const entries = await audit.list(workspaceId, 0n);
    expect(entries.map(entry => entry.action)).toContain(AuditActions.flagRestored);
    expect(await audit.verify(workspaceId)).toMatchObject({ intact: true });
  });
});
