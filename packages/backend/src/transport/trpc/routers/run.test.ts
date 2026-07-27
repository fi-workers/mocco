import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
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
      commits,
      configs,
      executor: new FakeExecutor(),
      callbackUrl: 'http://localhost:3100/api/ext/callback',
      waitUntil: () => {
        /* router tests don't assert the outbound dispatch */
      },
    });

  const signedInCaller = async (email: string) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    const roles = new RoleService({ roles: new RoleRepo(t.db), memberships: new RoleMembershipRepo(t.db) });
    return appRouter.createCaller({ auth, workspace, runs: makeRuns(), roles, session, headers });
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
});
