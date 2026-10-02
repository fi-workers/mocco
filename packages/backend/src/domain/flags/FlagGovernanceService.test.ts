import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFlagsDomain } from '@backend/domain/flags/compose';
import {
  ChangesetConflictError,
  ChangesetHashMismatchError,
  NotChangesetProposerError,
} from '@backend/domain/flags/errors';
import { SelfApprovalError } from '@backend/domain/governance/errors';
import { createApprovalService } from '@backend/domain/governance/instance';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { flagChangesets, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FlagsDomain } from '@backend/domain/flags/compose';
import type { ChangeOp } from '@mocco/common/flags';
import type { GateRequirements } from '@mocco/common/governance';

const releaseAndQa: GateRequirements = {
  resume: [
    { role: 'release', count: 1 },
    { role: 'qa', count: 1 },
  ],
  prevent_self: true,
  reason_required: false,
};
const enable = (isOn: boolean) => [{ op: 'set_enabled' as const, flagKey: 'checkout', enabled: isOn }];
const serveOff = [{ op: 'set_default_variant' as const, flagKey: 'checkout', variant: 'off' }];

describe('FlagGovernanceService (pglite)', () => {
  let t: TestDb;
  let audit: AuditService;
  let domain: FlagsDomain;
  let workspaceId: string;
  let projectId: string;
  let proposer: string;
  let environmentId: string;

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

  const environment = async () => expectOne(await domain.flags.listEnvironments(workspaceId, projectId));
  const propose = async (isOn: boolean, by = proposer, ops: ChangeOp[] = enable(isOn)) => {
    const { currentVersion } = await environment();
    return await domain.flags.applyChangeset(workspaceId, projectId, by, {
      environmentId,
      baseVersion: currentVersion,
      ops,
      reason: 'launch',
    });
  };
  const vote = async (
    voter: string,
    changeset: { id: string; contentHash: string },
    decision: 'approve' | 'reject' = 'approve',
  ) =>
    await domain.flagGovernance.vote(workspaceId, projectId, voter, {
      changesetId: changeset.id,
      contentHash: changeset.contentHash,
      decision,
    });
  const ruleset = async () => await domain.flags.ruleset(workspaceId, projectId, environmentId);

  beforeEach(async () => {
    t = await createTestDb();
    audit = new AuditService({ audit: new AuditRepo(t.db) });
    const approvals = createApprovalService(t.db, audit);
    domain = createFlagsDomain(t.db, { audit, approvals });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    proposer = await seedUser('release', 'qa');
    const created = await domain.flags.createEnvironment(workspaceId, projectId, proposer, {
      key: 'production',
      name: 'Production',
    });
    environmentId = created.id;
    await domain.flags.createBooleanFlag(workspaceId, projectId, proposer, {
      key: 'checkout',
      description: null,
      lifecycle: 'temporary',
    });
    await domain.flagGovernance.setChangeGate(workspaceId, projectId, proposer, { environmentId, gate: releaseAndQa });
  });
  afterEach(async () => {
    await t.close();
  });

  it('holds a change for approval, refuses one voter for two roles, and applies once the gate is met', async () => {
    const { outcome, changeset } = await propose(true);
    const both = await seedUser('release', 'qa');
    const qa = await seedUser('qa');

    const afterBoth = await vote(both, changeset);
    const pendingRuleset = await ruleset();
    const afterQa = await vote(qa, changeset);
    const appliedRuleset = await ruleset();

    expect(outcome).toBe('pending_approval');
    expect(changeset).toMatchObject({ state: 'pending', baseVersion: 1, requirements: releaseAndQa });
    expect(afterBoth.state).toBe('pending');
    expect(pendingRuleset.version).toBe(1);
    expect(afterQa).toMatchObject({ state: 'applied', appliedVersion: 2, id: changeset.id });
    expect(appliedRuleset.document).toMatchObject({ flags: { checkout: { state: 'ENABLED' } } });
    const entries = await audit.list(workspaceId, 0n);
    const actions = entries.map(entry => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([AuditActions.flagChangesetProposed, AuditActions.flagChangesetApplied]),
    );
    expect(await audit.verify(workspaceId)).toMatchObject({ intact: true });
  });

  it('refuses the proposer, and a vote on a hash other than the one pending', async () => {
    const { changeset } = await propose(true);
    const release = await seedUser('release');

    await expect(vote(proposer, changeset)).rejects.toThrow(SelfApprovalError);
    await expect(vote(release, { id: changeset.id, contentHash: 'f'.repeat(64) })).rejects.toThrow(
      ChangesetHashMismatchError,
    );
  });

  it('rebases onto the current version with a new hash, so earlier votes no longer count', async () => {
    const [applied, waiting] = [await propose(true), await propose(true, proposer, serveOff)];
    const release = await seedUser('release');
    const qa = await seedUser('qa');
    await vote(release, waiting.changeset);
    await vote(release, applied.changeset);
    await vote(qa, applied.changeset);

    const { changeset: rebased } = await domain.flagGovernance.rebase(
      workspaceId,
      projectId,
      proposer,
      waiting.changeset.id,
    );
    const [old] = await t.db.select().from(flagChangesets).where(eq(flagChangesets.id, waiting.changeset.id));
    const detail = await vote(qa, rebased);

    expect(old?.state).toBe('superseded');
    expect(rebased).toMatchObject({ state: 'pending', baseVersion: 2 });
    expect(rebased.contentHash).not.toBe(waiting.changeset.contentHash);
    await expect(vote(qa, waiting.changeset)).rejects.toThrow(/not pending/u);
    // release's vote was on the old changeset: qa alone doesn't meet release + qa.
    expect(detail.state).toBe('pending');
    const other = await seedUser('release');
    await expect(domain.flagGovernance.rebase(workspaceId, projectId, other, rebased.id)).rejects.toThrow(
      NotChangesetProposerError,
    );
  });

  it('marks a changeset conflicted when the environment moved past its base, and rebases it', async () => {
    const [a, b] = [await propose(true), await propose(true)];
    const release = await seedUser('release');
    const qa = await seedUser('qa');
    await vote(release, a.changeset);
    await vote(qa, a.changeset);

    await vote(release, b.changeset);
    const conflicted = await vote(qa, b.changeset);
    expect(conflicted.state).toBe('conflicted');

    // Its change is already in place: a rebase has nothing to propose, and the changeset stays.
    await expect(domain.flagGovernance.rebase(workspaceId, projectId, proposer, b.changeset.id)).rejects.toThrow(
      /does nothing/u,
    );
    const [still] = await t.db.select().from(flagChangesets).where(eq(flagChangesets.id, b.changeset.id));
    expect(still?.state).toBe('conflicted');
  });

  it('resolves rejections, withdrawals and expiry', async () => {
    const release = await seedUser('release');
    const rejected = await propose(true);
    await expect(vote(release, rejected.changeset, 'reject')).resolves.toMatchObject({ state: 'rejected' });

    const withdrawn = await propose(true);
    await expect(
      domain.flagGovernance.withdraw(workspaceId, projectId, release, withdrawn.changeset.id),
    ).rejects.toThrow(NotChangesetProposerError);
    await expect(
      domain.flagGovernance.withdraw(workspaceId, projectId, proposer, withdrawn.changeset.id),
    ).resolves.toMatchObject({ state: 'withdrawn' });

    const stale = await propose(true);
    await t.db
      .update(flagChangesets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(flagChangesets.id, stale.changeset.id));
    expect(await domain.flagGovernance.expireDue()).toBe(1);
    await expect(vote(release, stale.changeset)).rejects.toThrow(/not pending/u);
  });

  it('keeps in-flight changesets on the gate they were proposed under', async () => {
    const { changeset } = await propose(true);
    const release = await seedUser('release');
    const qa = await seedUser('qa');
    const stricter: GateRequirements = {
      resume: [{ role: 'release', count: 3 }],
      prevent_self: true,
      reason_required: true,
    };

    const gateChange = await domain.flagGovernance.setChangeGate(workspaceId, projectId, proposer, {
      environmentId,
      gate: stricter,
    });
    await domain.flags.listEnvironments(workspaceId, projectId);
    // The gate change itself is approved under the current gate.
    expect(gateChange.outcome).toBe('pending_approval');

    await vote(release, changeset);
    await expect(vote(qa, changeset)).resolves.toMatchObject({ state: 'applied' });
  });

  it('needs the current gate to remove protection, and changes at once without one', async () => {
    const release = await seedUser('release');
    const qa = await seedUser('qa');

    const removal = await domain.flagGovernance.setChangeGate(workspaceId, projectId, proposer, {
      environmentId,
      gate: null,
    });
    expect(removal.outcome).toBe('pending_approval');
    await expect(environment()).resolves.toMatchObject({ changeGate: releaseAndQa });
    await expect(propose(true)).resolves.toMatchObject({ outcome: 'pending_approval' });

    const { approvals } = (
      domain.flagGovernance as unknown as { deps: { approvals: ReturnType<typeof createApprovalService> } }
    ).deps;
    await approvals.vote(workspaceId, removal.requestId ?? '', release, 'approve');
    await approvals.vote(workspaceId, removal.requestId ?? '', qa, 'approve');

    await expect(environment()).resolves.toMatchObject({ changeGate: null });
    const { currentVersion } = await environment();
    await expect(
      domain.flags.applyChangeset(workspaceId, projectId, proposer, {
        environmentId,
        baseVersion: currentVersion,
        ops: enable(true),
        reason: null,
      }),
    ).resolves.toMatchObject({ outcome: 'applied' });
    await expect(
      domain.flags.applyChangeset(workspaceId, projectId, proposer, {
        environmentId,
        baseVersion: 0,
        ops: enable(false),
        reason: null,
      }),
    ).rejects.toThrow(ChangesetConflictError);
  });
});
