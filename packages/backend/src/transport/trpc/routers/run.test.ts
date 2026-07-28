import { randomUUID } from 'node:crypto';

import { ExecutorIds } from '@mocco/common/execution';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { GrantService } from '@backend/domain/credential/GrantService';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import { GateService } from '@backend/domain/governance/GateService';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { RoleService } from '@backend/domain/governance/RoleService';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { expectOne } from '@backend/infra/db/rows';
import { providerConnections, repos } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { appRouter } from '@backend/transport/trpc/root';

import type { MoccoConfig } from '@mocco/common/mocco-config';

const VALID_CONFIG: MoccoConfig = {
  version: 1,
  pipeline: 'deploy',
  steps: [
    { run: 'build', executor: 'generic' },
    { run: 'test', executor: 'generic' },
  ],
};

const signUpViaHttp = async (auth: AuthService, email: string) => {
  const response = await auth.handler(
    new Request('https://local.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'fixture-password-1', name: 'fixture-user' }),
    }),
  );
  return new Headers({ cookie: response.headers.get('set-cookie') ?? '' });
};

describe('run router on pglite', () => {
  let t: TestDb;
  let auth: AuthService;
  let workspace: WorkspaceService;
  let commits: CommitRepo;
  let configs: CommitConfigRepo;

  beforeEach(async () => {
    t = await createTestDb();
    const provider = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
    commits = new CommitRepo(t.db);
    configs = new CommitConfigRepo(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  const makeRuns = (): RunService =>
    new RunService({
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      commits,
      configs,
      executors: new Map([[ExecutorIds.generic, new FakeExecutor()]]),
      callbackUrl: 'http://localhost:3100/api/ext/callback',
      waitUntil: () => {
        /* router tests don't assert the outbound dispatch */
      },
    });

  const signedInCaller = async (email: string) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    const runs = makeRuns();
    const roles = new RoleService({ roles: new RoleRepo(t.db), memberships: new RoleMembershipRepo(t.db) });
    const gates = new GateService({
      runs: new RunRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      memberships: new RoleMembershipRepo(t.db),
      events: new RunEventRepo(t.db),
      resumeRun: async (run, gateItemIndex) => await runs.resumeFromGate(run, gateItemIndex),
    });
    const grants = new GrantService({ grants: new CredentialGrantRepo(t.db) });
    return appRouter.createCaller({ auth, workspace, runs, roles, gates, grants, session, headers });
  };

  // A caller that also exposes its user id, so a resumeGate test can assign it to a role.
  const signedInWithId = async (email: string) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    const runs = makeRuns();
    const roles = new RoleService({ roles: new RoleRepo(t.db), memberships: new RoleMembershipRepo(t.db) });
    const gates = new GateService({
      runs: new RunRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      memberships: new RoleMembershipRepo(t.db),
      events: new RunEventRepo(t.db),
      resumeRun: async (run, gateItemIndex) => await runs.resumeFromGate(run, gateItemIndex),
    });
    const grants = new GrantService({ grants: new CredentialGrantRepo(t.db) });
    const api = appRouter.createCaller({ auth, workspace, runs, roles, gates, grants, session, headers });
    return { api, userId: session?.user.id ?? '' };
  };

  /** Seed a repo + one commit under a workspace, returning the commit id. */
  const seedCommitId = async (workspaceId: string, sha: string): Promise<string> => {
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
    await commits.upsertMany([
      {
        repoId: repo.id,
        sha,
        branch: 'main',
        message: `commit ${sha}`,
        authorName: 'Author',
        authorEmail: 'author@example.com',
        committedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const [row] = await commits.listByRepo(repo.id, null, 1);
    if (row === undefined) {
      throw new Error('expected seeded commit row');
    }
    return row.id;
  };

  const seedRunnableCommit = async (workspaceId: string, sha: string): Promise<string> => {
    const commitId = await seedCommitId(workspaceId, sha);
    await configs.upsert({
      commitId,
      present: true,
      rawYaml: 'version: 1',
      parsedJson: VALID_CONFIG,
      valid: true,
      validationErrors: [],
    });
    return commitId;
  };

  describe('trigger', () => {
    it('creates a run and returns it without leaking the callback token hash', async () => {
      const api = await signedInCaller('trigger@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const commitId = await seedRunnableCommit(ws.id, 'sha-runnable');

      const { run } = await api.run.trigger({ workspaceId: ws.id, commitId });
      // trigger now starts the run: it is `running` (step 0 dispatched) on return.
      expect(run.state).toBe('running');
      expect(run.commitId).toBe(commitId);
      expect(run).not.toHaveProperty('callbackTokenHash'); // egress-stripped by .output(runSchema)
    });

    it('is BAD_REQUEST when the commit config is invalid (not runnable)', async () => {
      const api = await signedInCaller('trigger-invalid@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const commitId = await seedCommitId(ws.id, 'sha-invalid');
      await configs.upsert({
        commitId,
        present: true,
        rawYaml: 'version: 1\nsteps: []',
        parsedJson: null,
        valid: false,
        validationErrors: [{ path: 'steps', message: 'too small', code: 'too_small' }],
      });

      await expect(api.run.trigger({ workspaceId: ws.id, commitId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('is BAD_REQUEST when the commit has no config snapshot', async () => {
      const api = await signedInCaller('trigger-absent@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const commitId = await seedCommitId(ws.id, 'sha-unsnapshotted');

      await expect(api.run.trigger({ workspaceId: ws.id, commitId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('a non-member cannot trigger a run in another workspace (NOT_FOUND)', async () => {
      const owner = await signedInCaller('owner-trigger@example.com');
      const { workspace: wsA } = await owner.workspace.create({ name: 'A' });
      const commitId = await seedRunnableCommit(wsA.id, 'sha-cross');

      const stranger = await signedInCaller('stranger-trigger@example.com');
      await expect(stranger.run.trigger({ workspaceId: wsA.id, commitId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it("a commit belonging to another workspace maps to NOT_FOUND (querying B's own workspaceId with A's commitId)", async () => {
      const ownerA = await signedInCaller('owner-a-trigger@example.com');
      const { workspace: wsA } = await ownerA.workspace.create({ name: 'A' });
      const commitId = await seedRunnableCommit(wsA.id, 'sha-foreign');

      const memberB = await signedInCaller('member-b-trigger@example.com');
      const { workspace: wsB } = await memberB.workspace.create({ name: 'B' });

      await expect(memberB.run.trigger({ workspaceId: wsB.id, commitId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('get', () => {
    it('returns the run with its materialized steps (step 0 dispatched, rest pending)', async () => {
      const api = await signedInCaller('get@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const commitId = await seedRunnableCommit(ws.id, 'sha-get');
      const { run } = await api.run.trigger({ workspaceId: ws.id, commitId });

      const detail = await api.run.get({ workspaceId: ws.id, runId: run.id });
      expect(detail.run.id).toBe(run.id);
      expect(detail.steps).toHaveLength(2);
      expect(detail.steps.map(step => step.name)).toEqual(['build', 'test']);
      // trigger dispatches step 0; the rest stay pending until the loop advances.
      expect(detail.steps.map(step => step.status)).toEqual(['dispatched', 'pending']);
    });

    it('a non-member cannot read a run in another workspace (NOT_FOUND)', async () => {
      const owner = await signedInCaller('owner-get@example.com');
      const { workspace: wsA } = await owner.workspace.create({ name: 'A' });
      const commitId = await seedRunnableCommit(wsA.id, 'sha-get-cross');
      const { run } = await owner.run.trigger({ workspaceId: wsA.id, commitId });

      const stranger = await signedInCaller('stranger-get@example.com');
      await expect(stranger.run.get({ workspaceId: wsA.id, runId: run.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('an unknown runId is NOT_FOUND', async () => {
      const api = await signedInCaller('get-unknown@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      await expect(api.run.get({ workspaceId: ws.id, runId: randomUUID() })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('events', () => {
    it('returns the run.created event and serializes seq as a string; sinceSeq filters', async () => {
      const api = await signedInCaller('events@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const commitId = await seedRunnableCommit(ws.id, 'sha-events');
      const { run } = await api.run.trigger({ workspaceId: ws.id, commitId });

      const all = await api.run.events({ workspaceId: ws.id, runId: run.id, sinceSeq: '0' });
      // trigger emits run.created then step.dispatched (step 0 starts).
      expect(all.events.map(event => event.type)).toEqual(['run.created', 'step.dispatched']);
      expect(typeof all.events[0]?.seq).toBe('string'); // bigserial serialized as a string on the wire

      const latestSeq = all.events.at(-1)?.seq ?? '0';
      const since = await api.run.events({ workspaceId: ws.id, runId: run.id, sinceSeq: latestSeq });
      expect(since.events).toHaveLength(0);
      expect(since.run.id).toBe(run.id);
    });

    it('a non-numeric sinceSeq is rejected as BAD_REQUEST', async () => {
      const api = await signedInCaller('events-bad@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const commitId = await seedRunnableCommit(ws.id, 'sha-events-bad');
      const { run } = await api.run.trigger({ workspaceId: ws.id, commitId });

      await expect(api.run.events({ workspaceId: ws.id, runId: run.id, sinceSeq: 'abc' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('a non-member cannot read another workspace run events (NOT_FOUND)', async () => {
      const owner = await signedInCaller('owner-events@example.com');
      const { workspace: wsA } = await owner.workspace.create({ name: 'A' });
      const commitId = await seedRunnableCommit(wsA.id, 'sha-events-cross');
      const { run } = await owner.run.trigger({ workspaceId: wsA.id, commitId });

      const stranger = await signedInCaller('stranger-events@example.com');
      await expect(stranger.run.events({ workspaceId: wsA.id, runId: run.id, sinceSeq: '0' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('resumeGate', () => {
    const GATED_CONFIG: MoccoConfig = {
      version: 2,
      pipeline: 'deploy',
      steps: [
        { kind: 'gate', name: 'approve', resume: [{ role: 'deployer', count: 1 }] },
        { kind: 'step', run: 'ship', executor: 'generic' },
      ],
    };
    const PREVENT_SELF_CONFIG: MoccoConfig = {
      version: 2,
      pipeline: 'deploy',
      steps: [
        { kind: 'gate', name: 'approve', resume: [{ role: 'deployer', count: 1 }], prevent_self: true },
        { kind: 'step', run: 'ship', executor: 'generic' },
      ],
    };

    const seedGatedCommit = async (workspaceId: string, sha: string, config = GATED_CONFIG): Promise<string> => {
      const commitId = await seedCommitId(workspaceId, sha);
      await configs.upsert({
        commitId,
        present: true,
        rawYaml: 'version: 2',
        parsedJson: config,
        valid: true,
        validationErrors: [],
      });
      return commitId;
    };

    it('an authorized member resumes the current gate and the run continues', async () => {
      const { api, userId } = await signedInWithId('resume-ok@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const { role } = await api.role.create({ workspaceId: ws.id, name: 'deployer' });
      await api.role.addMember({ workspaceId: ws.id, roleId: role.id, userId });
      const commitId = await seedGatedCommit(ws.id, 'sha-gate-ok');

      const { run } = await api.run.trigger({ workspaceId: ws.id, commitId });
      expect(run.state).toBe('awaiting_gate');

      const resumed = await api.run.resumeGate({
        workspaceId: ws.id,
        runId: run.id,
        gateItemIndex: 0,
        decision: 'resume',
      });
      expect(resumed.gate.state).toBe('resumed');
      expect(resumed.run.state).toBe('running');
    });

    it('run.get exposes the run gates', async () => {
      const { api, userId } = await signedInWithId('gate-get@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const { role } = await api.role.create({ workspaceId: ws.id, name: 'deployer' });
      await api.role.addMember({ workspaceId: ws.id, roleId: role.id, userId });
      const commitId = await seedGatedCommit(ws.id, 'sha-gate-get');
      const { run } = await api.run.trigger({ workspaceId: ws.id, commitId });

      const detail = await api.run.get({ workspaceId: ws.id, runId: run.id });
      expect(detail.gates).toHaveLength(1);
      expect(detail.gates[0]).toMatchObject({ itemIndex: 0, name: 'approve', state: 'pending' });
    });

    it('a voter not in a required role is FORBIDDEN', async () => {
      const { api } = await signedInWithId('resume-forbidden@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      // The role exists but the caller is not a member of it.
      await api.role.create({ workspaceId: ws.id, name: 'deployer' });
      const commitId = await seedGatedCommit(ws.id, 'sha-gate-forbidden');
      const { run } = await api.run.trigger({ workspaceId: ws.id, commitId });

      await expect(
        api.run.resumeGate({ workspaceId: ws.id, runId: run.id, gateItemIndex: 0, decision: 'resume' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('prevent_self on the triggerer is BAD_REQUEST', async () => {
      const { api, userId } = await signedInWithId('resume-self@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const { role } = await api.role.create({ workspaceId: ws.id, name: 'deployer' });
      await api.role.addMember({ workspaceId: ws.id, roleId: role.id, userId });
      const commitId = await seedGatedCommit(ws.id, 'sha-gate-self', PREVENT_SELF_CONFIG);
      const { run } = await api.run.trigger({ workspaceId: ws.id, commitId });

      await expect(
        api.run.resumeGate({ workspaceId: ws.id, runId: run.id, gateItemIndex: 0, decision: 'resume' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('a gate index the run is not paused at is NOT_FOUND', async () => {
      const { api, userId } = await signedInWithId('resume-notcurrent@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const { role } = await api.role.create({ workspaceId: ws.id, name: 'deployer' });
      await api.role.addMember({ workspaceId: ws.id, roleId: role.id, userId });
      const commitId = await seedGatedCommit(ws.id, 'sha-gate-notcurrent');
      const { run } = await api.run.trigger({ workspaceId: ws.id, commitId });

      await expect(
        api.run.resumeGate({ workspaceId: ws.id, runId: run.id, gateItemIndex: 1, decision: 'resume' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a non-member cannot resume a gate in another workspace (NOT_FOUND)', async () => {
      const { api: owner, userId } = await signedInWithId('resume-owner@example.com');
      const { workspace: wsA } = await owner.workspace.create({ name: 'A' });
      const { role } = await owner.role.create({ workspaceId: wsA.id, name: 'deployer' });
      await owner.role.addMember({ workspaceId: wsA.id, roleId: role.id, userId });
      const commitId = await seedGatedCommit(wsA.id, 'sha-gate-cross');
      const { run } = await owner.run.trigger({ workspaceId: wsA.id, commitId });

      const stranger = await signedInCaller('resume-stranger@example.com');
      await expect(
        stranger.run.resumeGate({ workspaceId: wsA.id, runId: run.id, gateItemIndex: 0, decision: 'resume' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
