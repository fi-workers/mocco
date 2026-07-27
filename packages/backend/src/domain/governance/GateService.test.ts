import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import {
  DuplicateVoteError,
  GateNotCurrentError,
  NotAuthorizedToResumeError,
  PreventSelfError,
  ReasonRequiredError,
} from '@backend/domain/governance/errors';
import { GateService } from '@backend/domain/governance/GateService';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { expectOne } from '@backend/infra/db/rows';
import { providerConnections, repos, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { GateItem, MoccoConfig } from '@mocco/common/mocco-config';

describe('GateService (pglite)', () => {
  let t: TestDb;
  let commits: CommitRepo;
  let configs: CommitConfigRepo;
  let runService: RunService;
  let gateService: GateService;
  let roles: RoleRepo;
  let memberships: RoleMembershipRepo;
  let executor: FakeExecutor;

  beforeEach(async () => {
    t = await createTestDb();
    commits = new CommitRepo(t.db);
    configs = new CommitConfigRepo(t.db);
    roles = new RoleRepo(t.db);
    memberships = new RoleMembershipRepo(t.db);
    executor = new FakeExecutor();
    runService = new RunService({
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      commits,
      configs,
      executor,
      callbackUrl: 'http://localhost:3100/api/ext/callback',
      waitUntil: () => {
        /* the outbound trigger is fire-and-forget; the FakeExecutor records synchronously */
      },
    });
    gateService = new GateService({
      runs: new RunRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      memberships,
      events: new RunEventRepo(t.db),
      resumeRun: async (run, gateItemIndex) => await runService.resumeFromGate(run, gateItemIndex),
    });
  });
  afterEach(async () => {
    await t.close();
  });

  async function seedWorkspace(): Promise<string> {
    return expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
  }

  async function seedUser(): Promise<string> {
    return expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com` })
        .returning(),
    ).id;
  }

  async function seedRole(workspaceId: string, name: string, members: string[]): Promise<void> {
    const role = await roles.create({ workspaceId, name });
    await Promise.all(members.map(async userId => await memberships.add({ workspaceId, roleId: role.id, userId })));
  }

  /** Seed a runnable v2 commit whose FIRST item is a gate, so a triggered run pauses
   * at item 0 immediately (no step callback needed to reach the gate). */
  async function triggerGatedRun(
    workspaceId: string,
    gate: Omit<GateItem, 'kind'>,
    triggererId: string,
  ): Promise<string> {
    const conn = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    const repo = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: conn.id,
          externalRepoId: randomUUID(),
          owner: 'fi-workers',
          name: 'api',
          defaultBranch: 'main',
        })
        .returning(),
    );
    const sha = `sha-${randomUUID()}`;
    await commits.upsertMany([
      {
        repoId: repo.id,
        sha,
        branch: 'main',
        message: 'msg',
        authorName: 'Author',
        authorEmail: 'author@example.com',
        committedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const [commit] = await commits.listByRepo(repo.id, null, 1);
    if (commit === undefined) {
      throw new Error('expected seeded commit');
    }
    const config: MoccoConfig = {
      version: 2,
      pipeline: 'deploy',
      steps: [
        { kind: 'gate', ...gate },
        { kind: 'step', run: 'ship', executor: 'generic' },
      ],
    };
    await configs.upsert({
      commitId: commit.id,
      present: true,
      rawYaml: 'version: 2',
      parsedJson: config,
      valid: true,
      validationErrors: [],
    });
    const run = await runService.trigger(workspaceId, commit.id, triggererId);
    expect(run.state).toBe('awaiting_gate');
    return run.id;
  }

  /** Cast a resume vote on the current gate (index 0) and return the gate's new state. */
  const resumeState = async (workspaceId: string, runId: string, userId: string, reason?: string): Promise<string> => {
    const { gate } = await gateService.resume(workspaceId, runId, 0, userId, 'resume', reason);
    return gate.state;
  };

  describe('single-role N-of-M', () => {
    it('a single resume satisfies count:1 → gate resumed, run continues (next step dispatched)', async () => {
      const workspaceId = await seedWorkspace();
      const alice = await seedUser();
      const triggerer = await seedUser();
      await seedRole(workspaceId, 'deployer', [alice]);
      const runId = await triggerGatedRun(
        workspaceId,
        { name: 'approve', resume: [{ role: 'deployer', count: 1 }] },
        triggerer,
      );

      const { run, gate } = await gateService.resume(workspaceId, runId, 0, alice, 'resume');

      expect(gate.state).toBe('resumed');
      expect(gate.resolvedAt).not.toBeNull();
      expect(run.state).toBe('running');
      expect(run.currentIndex).toBe(1);
      // The gated step (ship, item 1) was dispatched by resumeFromGate.
      expect(executor.dispatches).toHaveLength(1);
      expect(executor.dispatches[0]?.ctx.stepIndex).toBe(1);
    });

    it('records the vote (one row per person, with its reason)', async () => {
      const workspaceId = await seedWorkspace();
      const alice = await seedUser();
      await seedRole(workspaceId, 'deployer', [alice]);
      const runId = await triggerGatedRun(
        workspaceId,
        { name: 'approve', resume: [{ role: 'deployer', count: 1 }] },
        await seedUser(),
      );

      await gateService.resume(workspaceId, runId, 0, alice, 'resume', 'looks good');

      const detail = await runService.get(workspaceId, runId);
      expect(detail.resumes).toHaveLength(1);
      expect(detail.resumes[0]).toMatchObject({
        userId: alice,
        decision: 'resume',
        reason: 'looks good',
        roleName: 'deployer',
      });
    });

    it('needs count:2 — the first vote leaves the gate pending, the second resumes it', async () => {
      const workspaceId = await seedWorkspace();
      const alice = await seedUser();
      const bob = await seedUser();
      await seedRole(workspaceId, 'deployer', [alice, bob]);
      const runId = await triggerGatedRun(
        workspaceId,
        { name: 'approve', resume: [{ role: 'deployer', count: 2 }] },
        await seedUser(),
      );

      const first = await gateService.resume(workspaceId, runId, 0, alice, 'resume');
      expect(first.gate.state).toBe('pending');
      expect(first.run.state).toBe('awaiting_gate');
      expect(executor.dispatches).toHaveLength(0);

      const second = await gateService.resume(workspaceId, runId, 0, bob, 'resume');
      expect(second.gate.state).toBe('resumed');
      expect(second.run.state).toBe('running');
      expect(executor.dispatches).toHaveLength(1);
    });
  });

  describe('multi-role AND & distinct principals', () => {
    it('requires a member of EACH role — one per role satisfies it', async () => {
      const workspaceId = await seedWorkspace();
      const alice = await seedUser();
      const carol = await seedUser();
      await seedRole(workspaceId, 'deployer', [alice]);
      await seedRole(workspaceId, 'sre', [carol]);
      const runId = await triggerGatedRun(
        workspaceId,
        {
          name: 'approve',
          resume: [
            { role: 'deployer', count: 1 },
            { role: 'sre', count: 1 },
          ],
        },
        await seedUser(),
      );

      expect(await resumeState(workspaceId, runId, alice)).toBe('pending');
      expect(await resumeState(workspaceId, runId, carol)).toBe('resumed');
    });

    it('counts DISTINCT principals — one person in two required roles fills only one slot', async () => {
      const workspaceId = await seedWorkspace();
      const alice = await seedUser(); // member of BOTH deployer and sre
      const bob = await seedUser(); // deployer only
      await seedRole(workspaceId, 'deployer', [alice, bob]);
      await seedRole(workspaceId, 'sre', [alice]);
      const runId = await triggerGatedRun(
        workspaceId,
        {
          name: 'approve',
          resume: [
            { role: 'deployer', count: 1 },
            { role: 'sre', count: 1 },
          ],
        },
        await seedUser(),
      );

      // Alice alone covers at most one of the two slots — still pending.
      expect(await resumeState(workspaceId, runId, alice)).toBe('pending');
      // Bob (deployer) fills deployer, freeing alice for sre → the matching completes.
      expect(await resumeState(workspaceId, runId, bob)).toBe('resumed');
    });
  });

  describe('policy guards', () => {
    it('prevent_self bars the run triggerer, but allows another eligible member', async () => {
      const workspaceId = await seedWorkspace();
      const alice = await seedUser();
      const bob = await seedUser();
      await seedRole(workspaceId, 'deployer', [alice, bob]);
      // Alice both triggers the run AND is a deployer.
      const runId = await triggerGatedRun(
        workspaceId,
        { name: 'approve', resume: [{ role: 'deployer', count: 1 }], prevent_self: true },
        alice,
      );

      await expect(gateService.resume(workspaceId, runId, 0, alice, 'resume')).rejects.toBeInstanceOf(PreventSelfError);
      // A different deployer can resume it.
      expect(await resumeState(workspaceId, runId, bob)).toBe('resumed');
    });

    it('rejects a voter who is not in any required role', async () => {
      const workspaceId = await seedWorkspace();
      const carol = await seedUser(); // in no role
      await seedRole(workspaceId, 'deployer', [await seedUser()]);
      const runId = await triggerGatedRun(
        workspaceId,
        { name: 'approve', resume: [{ role: 'deployer', count: 1 }] },
        await seedUser(),
      );

      await expect(gateService.resume(workspaceId, runId, 0, carol, 'resume')).rejects.toBeInstanceOf(
        NotAuthorizedToResumeError,
      );
    });

    it('enforces reason_required — no reason is rejected, a reason is accepted', async () => {
      const workspaceId = await seedWorkspace();
      const alice = await seedUser();
      await seedRole(workspaceId, 'deployer', [alice]);
      const runId = await triggerGatedRun(
        workspaceId,
        { name: 'approve', resume: [{ role: 'deployer', count: 1 }], reason_required: true },
        await seedUser(),
      );

      await expect(gateService.resume(workspaceId, runId, 0, alice, 'resume')).rejects.toBeInstanceOf(
        ReasonRequiredError,
      );
      await expect(gateService.resume(workspaceId, runId, 0, alice, 'resume', ' '.repeat(3))).rejects.toBeInstanceOf(
        ReasonRequiredError,
      );
      expect(await resumeState(workspaceId, runId, alice, 'ship it')).toBe('resumed');
    });

    it('rejects a second vote by the same person', async () => {
      const workspaceId = await seedWorkspace();
      const alice = await seedUser();
      await seedRole(workspaceId, 'deployer', [alice]);
      // count:2 keeps the gate pending after alice's first vote.
      const runId = await triggerGatedRun(
        workspaceId,
        { name: 'approve', resume: [{ role: 'deployer', count: 2 }] },
        await seedUser(),
      );

      await gateService.resume(workspaceId, runId, 0, alice, 'resume');
      await expect(gateService.resume(workspaceId, runId, 0, alice, 'resume')).rejects.toBeInstanceOf(
        DuplicateVoteError,
      );
    });
  });

  describe('reject halts the run', () => {
    it('a single reject vote rejects the gate and the run (short-circuits N-of-M)', async () => {
      const workspaceId = await seedWorkspace();
      const alice = await seedUser();
      await seedRole(workspaceId, 'deployer', [alice]);
      const runId = await triggerGatedRun(
        workspaceId,
        { name: 'approve', resume: [{ role: 'deployer', count: 2 }] },
        await seedUser(),
      );

      const { run, gate } = await gateService.resume(workspaceId, runId, 0, alice, 'reject', 'not safe');

      expect(gate.state).toBe('rejected');
      expect(run.state).toBe('rejected');
      expect(run.finishedAt).not.toBeNull();
      // The gated step is never dispatched.
      expect(executor.dispatches).toHaveLength(0);

      const { events } = await runService.observe(workspaceId, runId, 0n);
      expect(events.map(event => event.type)).toContain('gate.rejected');
      expect(events.map(event => event.type)).toContain('run.rejected');
    });
  });

  describe('not-current / foreign gate', () => {
    it('rejects a vote on a gate index the run is not paused at', async () => {
      const workspaceId = await seedWorkspace();
      const alice = await seedUser();
      await seedRole(workspaceId, 'deployer', [alice]);
      const runId = await triggerGatedRun(
        workspaceId,
        { name: 'approve', resume: [{ role: 'deployer', count: 1 }] },
        await seedUser(),
      );

      // The run is paused at index 0; index 1 is a step, not a current gate.
      await expect(gateService.resume(workspaceId, runId, 1, alice, 'resume')).rejects.toBeInstanceOf(
        GateNotCurrentError,
      );
    });

    it('rejects a vote scoped to a foreign workspace (tenant isolation)', async () => {
      const workspaceId = await seedWorkspace();
      const alice = await seedUser();
      await seedRole(workspaceId, 'deployer', [alice]);
      const runId = await triggerGatedRun(
        workspaceId,
        { name: 'approve', resume: [{ role: 'deployer', count: 1 }] },
        await seedUser(),
      );
      const otherWorkspaceId = await seedWorkspace();

      await expect(gateService.resume(otherWorkspaceId, runId, 0, alice, 'resume')).rejects.toBeInstanceOf(
        GateNotCurrentError,
      );
    });

    it('rejects a second vote after the gate already resolved', async () => {
      const workspaceId = await seedWorkspace();
      const alice = await seedUser();
      const bob = await seedUser();
      await seedRole(workspaceId, 'deployer', [alice, bob]);
      const runId = await triggerGatedRun(
        workspaceId,
        { name: 'approve', resume: [{ role: 'deployer', count: 1 }] },
        await seedUser(),
      );

      await gateService.resume(workspaceId, runId, 0, alice, 'resume'); // resolves the gate
      // The run moved past the gate — bob's late vote is no longer actionable.
      await expect(gateService.resume(workspaceId, runId, 0, bob, 'resume')).rejects.toBeInstanceOf(
        GateNotCurrentError,
      );
    });
  });
});
