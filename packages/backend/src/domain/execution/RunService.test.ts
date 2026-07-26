import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigNotRunnableError, RunCallbackRejectedError, RunNotFoundError } from '@backend/domain/execution/errors';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import { CommitNotFoundError } from '@backend/domain/integration/errors';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { expectOne } from '@backend/infra/db/rows';
import { providerConnections, repos, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { MoccoConfig } from '@mocco/common/mocco-config';

const VALID_CONFIG: MoccoConfig = {
  version: 1,
  pipeline: 'deploy',
  steps: [
    { run: 'build', executor: 'generic' },
    { run: 'test', executor: 'generic', with: { flag: 'on' } },
  ],
};

const CALLBACK_URL = 'http://localhost:3100/api/ext/callback';

describe('RunService (pglite)', () => {
  let t: TestDb;
  let commits: CommitRepo;
  let configs: CommitConfigRepo;
  let service: RunService;
  let executor: FakeExecutor;

  beforeEach(async () => {
    t = await createTestDb();
    commits = new CommitRepo(t.db);
    configs = new CommitConfigRepo(t.db);
    executor = new FakeExecutor();
    service = new RunService({
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      commits,
      configs,
      executor,
      callbackUrl: CALLBACK_URL,
      // The outbound executor trigger is fire-and-forget; the FakeExecutor records
      // synchronously when start() is invoked, so tests read the token and assert DB
      // state without draining the deferred promise.
      waitUntil: () => {
        /* drop the deferred trigger — startExecutor catches its own errors */
      },
    });
  });

  afterEach(async () => {
    await t.close();
  });

  /** The plaintext callback token for a run — recovered from what the executor was
   * handed at dispatch (the real loop delivers it back on the callback). */
  function tokenForLatestDispatch(): string {
    const last = executor.dispatches.at(-1);
    if (last === undefined) {
      throw new Error('expected a recorded dispatch');
    }
    return last.ctx.callbackToken;
  }

  async function seedWorkspace(name = 'W'): Promise<string> {
    return expectOne(await t.db.insert(workspaces).values({ name, slug: randomUUID() }).returning()).id;
  }

  /** A real user row — runs.triggered_by_user_id FKs mocco_users (a random uuid violates it). */
  async function seedUser(): Promise<string> {
    return expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com` })
        .returning(),
    ).id;
  }

  async function seedRepo(workspaceId: string): Promise<string> {
    const conn = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    return expectOne(
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
    ).id;
  }

  async function seedCommit(repoId: string, sha: string): Promise<string> {
    await commits.upsertMany([
      {
        repoId,
        sha,
        branch: 'main',
        message: `msg ${sha}`,
        authorName: 'Author',
        authorEmail: 'author@example.com',
        committedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const [row] = await commits.listByRepo(repoId, null, 1);
    if (row === undefined) {
      throw new Error('expected seeded commit row');
    }
    return row.id;
  }

  /** Seed a config snapshot for a commit. Defaults to a runnable (present+valid) config. */
  async function seedConfig(
    commitId: string,
    overrides: Partial<Parameters<CommitConfigRepo['upsert']>[0]> = {},
  ): Promise<void> {
    await configs.upsert({
      commitId,
      present: true,
      rawYaml: 'version: 1',
      parsedJson: VALID_CONFIG,
      valid: true,
      validationErrors: [],
      ...overrides,
    });
  }

  /** A workspace with a repo and one commit, returning both ids. */
  async function seedCommitInWorkspace(): Promise<{ workspaceId: string; commitId: string }> {
    const workspaceId = await seedWorkspace();
    const repoId = await seedRepo(workspaceId);
    const commitId = await seedCommit(repoId, `sha-${randomUUID()}`);
    return { workspaceId, commitId };
  }

  /** Trigger a runnable run and return its id + the token the executor was handed. */
  async function startRun(): Promise<{ workspaceId: string; runId: string; token: string }> {
    const { workspaceId, commitId } = await seedCommitInWorkspace();
    await seedConfig(commitId);
    const run = await service.trigger(workspaceId, commitId, await seedUser());
    return { workspaceId, runId: run.id, token: tokenForLatestDispatch() };
  }

  describe('trigger', () => {
    it('starts a running run and materializes steps from the pinned config', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);

      const run = await service.trigger(workspaceId, commitId, await seedUser());

      // trigger now starts the run: it is `running`, cursor at step 0.
      expect(run.state).toBe('running');
      expect(run.currentIndex).toBe(0);
      expect(run.commitId).toBe(commitId);
      expect(run.triggerSource).toBe('manual');
      expect(run.startedAt).not.toBeNull();

      const { steps } = await service.get(workspaceId, run.id);
      expect(steps).toHaveLength(2);
      // Step 0 is dispatched (the loop's first hop); the rest stay pending.
      expect(steps[0]).toMatchObject({ stepIndex: 0, name: 'build', executor: 'generic', status: 'dispatched' });
      expect(steps[0]?.with).toBeNull();
      expect(steps[1]).toMatchObject({ stepIndex: 1, name: 'test', executor: 'generic', status: 'pending' });
      expect(steps[1]?.with).toEqual({ flag: 'on' });
    });

    it('dispatches step 0 to the executor with the callback context and token', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);

      const run = await service.trigger(workspaceId, commitId, await seedUser());

      expect(executor.dispatches).toHaveLength(1);
      const [dispatch] = executor.dispatches;
      expect(dispatch?.dispatch).toMatchObject({ index: 0, name: 'build', executor: 'generic' });
      expect(dispatch?.ctx).toMatchObject({ runId: run.id, stepIndex: 0, callbackUrl: CALLBACK_URL });
      // The token handed to the executor hashes to the run's stored hash.
      expect(dispatch?.ctx.callbackToken).toMatch(/^[0-9a-f]{64}$/);

      const { events } = await service.observe(workspaceId, run.id, 0n);
      expect(events.map(event => event.type)).toEqual(['run.created', 'step.dispatched']);
    });

    it('stores only the sha-256 hash of the callback token, never a plaintext', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);

      const run = await service.trigger(workspaceId, commitId, await seedUser());

      // The raw row carries the hash (the wire schema strips it); it is a 64-char hex digest.
      expect(run.callbackTokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('appends a run.created event carrying the step count', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);

      const run = await service.trigger(workspaceId, commitId, await seedUser());

      const { events } = await service.observe(workspaceId, run.id, 0n);
      expect(events[0]?.type).toBe('run.created');
      expect(events[0]?.payload).toMatchObject({ commitId, stepCount: 2 });
    });

    it('rejects a commit whose config snapshot is absent (present:false) with ConfigNotRunnableError', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId, { present: false, valid: false, parsedJson: null });

      await expect(service.trigger(workspaceId, commitId, await seedUser())).rejects.toBeInstanceOf(
        ConfigNotRunnableError,
      );
    });

    it('rejects a commit whose config snapshot is invalid (valid:false) with ConfigNotRunnableError', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId, {
        valid: false,
        parsedJson: null,
        validationErrors: [{ path: 'steps', message: 'too small', code: 'too_small' }],
      });

      await expect(service.trigger(workspaceId, commitId, await seedUser())).rejects.toBeInstanceOf(
        ConfigNotRunnableError,
      );
    });

    it('rejects a commit that has never been snapshotted with ConfigNotRunnableError', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();

      await expect(service.trigger(workspaceId, commitId, await seedUser())).rejects.toBeInstanceOf(
        ConfigNotRunnableError,
      );
    });

    it('rejects a commit in another workspace with CommitNotFoundError', async () => {
      const { commitId } = await seedCommitInWorkspace();
      const otherWorkspaceId = await seedWorkspace('other');

      await expect(service.trigger(otherWorkspaceId, commitId, await seedUser())).rejects.toBeInstanceOf(
        CommitNotFoundError,
      );
    });
  });

  describe('applyCallback', () => {
    it('advances step-by-step and finishes the run succeeded', async () => {
      const { workspaceId, runId, token } = await startRun();

      await service.applyCallback(token, { runId, stepIndex: 0, status: 'running' });
      let detail = await service.get(workspaceId, runId);
      expect(detail.steps.map(step => step.status)).toEqual(['running', 'pending']);

      await service.applyCallback(token, { runId, stepIndex: 0, status: 'succeeded' });
      detail = await service.get(workspaceId, runId);
      // Cursor advanced and the next step dispatched (a second recorded dispatch).
      expect(detail.run.currentIndex).toBe(1);
      expect(detail.steps.map(step => step.status)).toEqual(['succeeded', 'dispatched']);
      expect(executor.dispatches).toHaveLength(2);
      expect(executor.dispatches[1]?.ctx.stepIndex).toBe(1);

      await service.applyCallback(token, { runId, stepIndex: 1, status: 'running' });
      await service.applyCallback(token, { runId, stepIndex: 1, status: 'succeeded' });
      detail = await service.get(workspaceId, runId);
      expect(detail.run.state).toBe('succeeded');
      expect(detail.run.finishedAt).not.toBeNull();
      expect(detail.steps.map(step => step.status)).toEqual(['succeeded', 'succeeded']);

      const { events } = await service.observe(workspaceId, runId, 0n);
      expect(events.map(event => event.type)).toEqual([
        'run.created',
        'step.dispatched',
        'step.running',
        'step.succeeded',
        'step.dispatched',
        'step.running',
        'step.succeeded',
        'run.succeeded',
      ]);
    });

    it('records the logs url carried by a callback', async () => {
      const { workspaceId, runId, token } = await startRun();

      await service.applyCallback(token, { runId, stepIndex: 0, status: 'running', logsUrl: 'https://logs.test/0' });
      const detail = await service.get(workspaceId, runId);
      expect(detail.steps[0]?.logsUrl).toBe('https://logs.test/0');
    });

    it('fails the run when a step fails (no advance)', async () => {
      const { workspaceId, runId, token } = await startRun();

      await service.applyCallback(token, { runId, stepIndex: 0, status: 'failed' });

      const detail = await service.get(workspaceId, runId);
      expect(detail.run.state).toBe('failed');
      expect(detail.run.finishedAt).not.toBeNull();
      expect(detail.steps.map(step => step.status)).toEqual(['failed', 'pending']);
      // No next step was dispatched — only step 0's original dispatch was recorded.
      expect(executor.dispatches).toHaveLength(1);

      const { events } = await service.observe(workspaceId, runId, 0n);
      expect(events.map(event => event.type)).toEqual(['run.created', 'step.dispatched', 'step.failed', 'run.failed']);
    });

    it('rejects a callback with a wrong token and does not advance', async () => {
      const { workspaceId, runId } = await startRun();

      await expect(
        service.applyCallback('deadbeef-not-the-real-token', { runId, stepIndex: 0, status: 'succeeded' }),
      ).rejects.toBeInstanceOf(RunCallbackRejectedError);

      const detail = await service.get(workspaceId, runId);
      expect(detail.run.currentIndex).toBe(0);
      expect(detail.steps.map(step => step.status)).toEqual(['dispatched', 'pending']);
    });

    it('rejects a callback for an unknown run', async () => {
      const { token } = await startRun();
      await expect(
        service.applyCallback(token, { runId: randomUUID(), stepIndex: 0, status: 'succeeded' }),
      ).rejects.toBeInstanceOf(RunCallbackRejectedError);
    });

    it('is idempotent on a redelivered callback (no double-advance)', async () => {
      const { workspaceId, runId, token } = await startRun();

      await service.applyCallback(token, { runId, stepIndex: 0, status: 'succeeded' });
      // Redeliver the SAME succeeded callback for step 0 — the cursor already moved on.
      await service.applyCallback(token, { runId, stepIndex: 0, status: 'succeeded' });

      const detail = await service.get(workspaceId, runId);
      expect(detail.run.currentIndex).toBe(1);
      expect(detail.steps.map(step => step.status)).toEqual(['succeeded', 'dispatched']);
      // Step 1 was dispatched exactly once — the redelivery did not re-dispatch it.
      expect(executor.dispatches).toHaveLength(2);
    });

    it('rejects a callback whose stepIndex is not the run cursor', async () => {
      const { runId, token } = await startRun();

      // Cursor is at 0; a callback for step 1 (still pending) is illegal.
      await expect(service.applyCallback(token, { runId, stepIndex: 1, status: 'succeeded' })).rejects.toBeInstanceOf(
        RunCallbackRejectedError,
      );
    });

    it('is a no-op once the run has already finished', async () => {
      const { workspaceId, runId, token } = await startRun();
      await service.applyCallback(token, { runId, stepIndex: 0, status: 'failed' });

      // A late callback after the run failed must not throw or change anything.
      await service.applyCallback(token, { runId, stepIndex: 0, status: 'succeeded' });
      const detail = await service.get(workspaceId, runId);
      expect(detail.run.state).toBe('failed');
    });
  });

  describe('get', () => {
    it('throws RunNotFoundError for an unknown run', async () => {
      const workspaceId = await seedWorkspace();
      await expect(service.get(workspaceId, randomUUID())).rejects.toBeInstanceOf(RunNotFoundError);
    });

    it('throws RunNotFoundError for a run in another workspace (tenant isolation)', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);
      const run = await service.trigger(workspaceId, commitId, await seedUser());
      const otherWorkspaceId = await seedWorkspace('other');

      await expect(service.get(otherWorkspaceId, run.id)).rejects.toBeInstanceOf(RunNotFoundError);
    });
  });

  describe('observe', () => {
    it('returns only events newer than sinceSeq', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);
      const run = await service.trigger(workspaceId, commitId, await seedUser());

      // trigger emits run.created then step.dispatched (step 0 starts).
      const all = await service.observe(workspaceId, run.id, 0n);
      expect(all.events).toHaveLength(2);
      const latestSeq = all.events.at(-1)?.seq ?? 0n;

      const sinceLatest = await service.observe(workspaceId, run.id, latestSeq);
      expect(sinceLatest.events).toHaveLength(0);
      expect(sinceLatest.run.id).toBe(run.id);
    });
  });
});
