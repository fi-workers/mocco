import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ExecutorIds } from '@mocco/common/execution';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { ConfigNotRunnableError, RunCallbackRejectedError, RunNotFoundError } from '@backend/domain/execution/errors';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
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
  let pending: Promise<unknown>[];

  beforeEach(async () => {
    t = await createTestDb();
    commits = new CommitRepo(t.db);
    configs = new CommitConfigRepo(t.db);
    executor = new FakeExecutor();
    pending = [];
    service = new RunService({
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      commits,
      configs,
      // Only the generic adapter is registered; a step with any other executor id
      // (e.g. an unregistered `github-actions`) fails its run closed.
      executors: new Map([[ExecutorIds.generic, executor]]),
      callbackUrl: CALLBACK_URL,
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      // The outbound executor trigger is fire-and-forget. The FakeExecutor records
      // synchronously when start() is invoked, so most tests read the token and
      // assert DB state without draining; the deferred promises are collected here
      // so the fail-closed path (which writes only in the deferred pass) can be
      // drained when a test needs it.
      waitUntil: p => {
        pending.push(p);
      },
    });
  });

  afterEach(async () => {
    await t.close();
  });

  /** Drain every collected deferred promise, including ones scheduled while draining. */
  async function drain(): Promise<void> {
    while (pending.length > 0) {
      const p = pending.shift();
      // eslint-disable-next-line no-await-in-loop
      await p;
    }
  }

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

  describe('audit write-path (slice 8)', () => {
    it('appends a run.triggered entry (actor = triggerer, subject = run, payload = commitId) and the chain verifies', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);
      const userId = await seedUser();

      const run = await service.trigger(workspaceId, commitId, userId);

      const auditRepo = new AuditRepo(t.db);
      const entries = await auditRepo.all(workspaceId);
      const triggered = entries.find(entry => entry.action === AuditActions.runTriggered);
      expect(triggered).toBeDefined();
      expect(triggered?.actorUserId).toBe(userId);
      expect(triggered?.subjectType).toBe('run');
      expect(triggered?.subjectId).toBe(run.id);
      expect(triggered?.payload).toMatchObject({ commitId });

      const verified = await new AuditService({ audit: auditRepo }).verify(workspaceId);
      expect(verified).toEqual({ intact: true });
    });

    it('is fail-open — a run trigger still succeeds even when audit.record throws', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const boom = new Error('audit db down');
      const throwingAudit = new AuditService({
        audit: { lastHash: vi.fn().mockRejectedValue(boom), append: vi.fn().mockRejectedValue(boom) } as never,
      });
      const failing = new RunService({
        runs: new RunRepo(t.db),
        steps: new RunStepRepo(t.db),
        events: new RunEventRepo(t.db),
        runGates: new RunGateRepo(t.db),
        resumes: new ResumeRepo(t.db),
        commits,
        configs,
        executors: new Map([[ExecutorIds.generic, executor]]),
        callbackUrl: CALLBACK_URL,
        audit: throwingAudit,
        waitUntil: p => {
          pending.push(p);
        },
      });
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);

      const run = await failing.trigger(workspaceId, commitId, await seedUser());
      // The governed action completed despite the audit append failing.
      expect(run.state).toBe('running');
      spy.mockRestore();
    });
  });

  describe('executor registry', () => {
    it('routes a github-actions step to the registered github executor, not the generic one', async () => {
      // A registry with BOTH adapters registered (mirrors the composition root once
      // the GitHub App is configured). A `github-actions` step must land on the
      // github adapter, leaving the generic one untouched.
      const githubExecutor = new FakeExecutor();
      const routed = new RunService({
        runs: new RunRepo(t.db),
        steps: new RunStepRepo(t.db),
        events: new RunEventRepo(t.db),
        runGates: new RunGateRepo(t.db),
        resumes: new ResumeRepo(t.db),
        commits,
        configs,
        executors: new Map([
          [ExecutorIds.generic, executor],
          [ExecutorIds.githubActions, githubExecutor],
        ]),
        callbackUrl: CALLBACK_URL,
        audit: new AuditService({ audit: new AuditRepo(t.db) }),
        waitUntil: p => {
          pending.push(p);
        },
      });
      const githubConfig: MoccoConfig = {
        version: 1,
        pipeline: 'deploy',
        steps: [{ run: 'build', executor: ExecutorIds.githubActions }],
      };
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId, { parsedJson: githubConfig });

      const run = await routed.trigger(workspaceId, commitId, await seedUser());
      await drain();

      // The step's `github-actions` id resolved to the github executor.
      expect(githubExecutor.dispatches).toHaveLength(1);
      expect(githubExecutor.dispatches[0]?.dispatch.executor).toBe(ExecutorIds.githubActions);
      // The generic executor was never handed this step.
      expect(executor.dispatches).toHaveLength(0);
      const detail = await routed.get(workspaceId, run.id);
      expect(detail.run.state).toBe('running');
      expect(detail.steps[0]?.status).toBe('dispatched');
    });

    it('routes a generic step through the registry to the registered generic executor', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);

      const run = await service.trigger(workspaceId, commitId, await seedUser());

      // The step's `generic` id resolved to the registered executor and was dispatched.
      expect(executor.dispatches).toHaveLength(1);
      expect(executor.dispatches[0]?.dispatch.executor).toBe(ExecutorIds.generic);
      await drain();
      const detail = await service.get(workspaceId, run.id);
      expect(detail.run.state).toBe('running');
      expect(detail.steps[0]?.status).toBe('dispatched');
    });

    it('fails a run closed when a step has an unregistered executor (no dispatch)', async () => {
      const unknownExecutorConfig: MoccoConfig = {
        version: 1,
        pipeline: 'deploy',
        // `github-actions` is a defined id (ExecutorIds) but not registered in this
        // service's registry — the fail-closed case (the PR2 adapter isn't wired yet).
        steps: [{ run: 'build', executor: ExecutorIds.githubActions }],
      };
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId, { parsedJson: unknownExecutorConfig });

      const run = await service.trigger(workspaceId, commitId, await seedUser());
      // The unresolved executor is discovered in the deferred dispatch pass.
      await drain();

      const detail = await service.get(workspaceId, run.id);
      expect(detail.run.state).toBe('failed');
      expect(detail.run.finishedAt).not.toBeNull();
      expect(detail.steps.map(step => step.status)).toEqual(['failed']);
      // Nothing was handed to any registered executor — fail-closed, not a silent stall.
      expect(executor.dispatches).toHaveLength(0);

      const { events } = await service.observe(workspaceId, run.id, 0n);
      expect(events.map(event => event.type)).toEqual(['run.created', 'step.dispatched', 'step.failed', 'run.failed']);
      // The step.failed payload names the unknown executor for the timeline.
      const failed = events.find(event => event.type === 'step.failed');
      expect(failed?.payload).toMatchObject({ stepIndex: 0, name: 'build', executor: ExecutorIds.githubActions });
    });
  });

  describe('v2 gates', () => {
    const V2_CONFIG: MoccoConfig = {
      version: 2,
      pipeline: 'deploy',
      steps: [
        { kind: 'step', run: 'build', executor: 'generic' },
        { kind: 'gate', name: 'approve', resume: [{ role: 'deployer', count: 2 }], prevent_self: true },
        { kind: 'step', run: 'ship', executor: 'generic' },
      ],
    };

    /** Trigger a v2 run and return its id + the token handed to the executor. */
    async function startV2Run(config: MoccoConfig = V2_CONFIG): Promise<{ workspaceId: string; runId: string }> {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId, { parsedJson: config });
      const run = await service.trigger(workspaceId, commitId, await seedUser());
      return { workspaceId, runId: run.id };
    }

    it('materializes steps and gates by item index (a gate snapshots its requirements)', async () => {
      const { workspaceId, runId } = await startV2Run();

      const detail = await service.get(workspaceId, runId);
      // Two step items (indices 0, 2) and one gate item (index 1).
      expect(detail.steps.map(step => step.stepIndex)).toEqual([0, 2]);
      expect(detail.steps.map(step => step.name)).toEqual(['build', 'ship']);
      expect(detail.gates).toHaveLength(1);
      expect(detail.gates[0]).toMatchObject({ itemIndex: 1, name: 'approve', state: 'pending' });
      expect(detail.gates[0]?.requirements).toEqual({
        resume: [{ role: 'deployer', count: 2 }],
        prevent_self: true,
        reason_required: false,
      });
    });

    it('pauses at a gate on advance — awaiting_gate, no dispatch, gate.pending emitted', async () => {
      const { workspaceId, runId } = await startV2Run();
      const token = tokenForLatestDispatch();
      // Step 0 dispatched at trigger.
      expect(executor.dispatches).toHaveLength(1);

      // Step 0 succeeds → advance lands on the gate at item 1 → pause.
      await service.applyCallback(token, { runId, stepIndex: 0, status: 'succeeded' });

      const detail = await service.get(workspaceId, runId);
      expect(detail.run.state).toBe('awaiting_gate');
      expect(detail.run.currentIndex).toBe(1);
      expect(detail.gates[0]?.state).toBe('pending');
      // No further dispatch — the gated step is not started.
      expect(executor.dispatches).toHaveLength(1);
      expect(detail.steps.map(step => step.status)).toEqual(['succeeded', 'pending']);

      const { events } = await service.observe(workspaceId, runId, 0n);
      expect(events.map(event => event.type)).toEqual([
        'run.created',
        'step.dispatched',
        'step.succeeded',
        'gate.pending',
      ]);
    });

    it('resumeFromGate advances past the gate and dispatches the next step', async () => {
      const { workspaceId, runId } = await startV2Run();
      const token = tokenForLatestDispatch();
      await service.applyCallback(token, { runId, stepIndex: 0, status: 'succeeded' });

      const paused = await service.get(workspaceId, runId);
      await service.resumeFromGate(paused.run, 1);

      const detail = await service.get(workspaceId, runId);
      expect(detail.run.state).toBe('running');
      expect(detail.run.currentIndex).toBe(2);
      // The next step (ship, item 2) is now dispatched — a second executor dispatch.
      expect(executor.dispatches).toHaveLength(2);
      expect(executor.dispatches[1]?.ctx.stepIndex).toBe(2);
      expect(detail.steps.map(step => step.status)).toEqual(['succeeded', 'dispatched']);

      // resumeFromGate rotates the callback token; the next step's callback uses the new one.
      const newToken = tokenForLatestDispatch();
      await service.applyCallback(newToken, { runId, stepIndex: 2, status: 'succeeded' });
      const done = await service.get(workspaceId, runId);
      expect(done.run.state).toBe('succeeded');
    });

    it('pauses immediately when item 0 is a gate (no step dispatched at trigger)', async () => {
      const gateFirst: MoccoConfig = {
        version: 2,
        pipeline: 'deploy',
        steps: [
          { kind: 'gate', name: 'gate-0', resume: [{ role: 'sre', count: 1 }] },
          { kind: 'step', run: 'ship', executor: 'generic' },
        ],
      };
      const { workspaceId, runId } = await startV2Run(gateFirst);

      const detail = await service.get(workspaceId, runId);
      expect(detail.run.state).toBe('awaiting_gate');
      expect(detail.run.currentIndex).toBe(0);
      expect(executor.dispatches).toHaveLength(0);
      expect(detail.run.startedAt).not.toBeNull();
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
