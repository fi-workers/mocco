import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { RunCallbackStatuses, RunStates, RunStepStatuses } from '@mocco/common/execution';
import { moccoConfigSchema } from '@mocco/common/mocco-config';

import { ConfigNotRunnableError, RunCallbackRejectedError, RunNotFoundError } from '@backend/domain/execution/errors';
import { CommitNotFoundError } from '@backend/domain/integration/errors';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { Executor, RunStepDispatch } from '@backend/domain/execution/ports';
import type { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import type { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import type { RunRepo } from '@backend/domain/execution/repos/run.repo';
import type { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import type { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import type { DispatchContext, RunCallbackStatus, RunState, RunStepStatus } from '@mocco/common/execution';

/** Byte length of the opaque per-run callback token. 32 bytes = 256 bits of entropy. */
const CALLBACK_TOKEN_BYTES = 32;

/** Run-event types this service emits — the append-only progression log that drives
 * the live timeline. Free-form strings on the wire (`runEventSchema.type` is a
 * string); centralized here as the single source of truth for the emitters. */
const RunEventTypes = {
  runCreated: 'run.created',
  stepDispatched: 'step.dispatched',
  stepRunning: 'step.running',
  stepSucceeded: 'step.succeeded',
  stepFailed: 'step.failed',
  runSucceeded: 'run.succeeded',
  runFailed: 'run.failed',
} as const;

/** Run states from which no callback can advance the machine — a redelivered final
 * callback after the run finished is a no-op. */
const TERMINAL_RUN_STATES = new Set<RunState>([RunStates.succeeded, RunStates.failed, RunStates.canceled]);

/** Step statuses that are settled — a redelivered callback for such a step is idempotent. */
const TERMINAL_STEP_STATUSES = new Set<RunStepStatus>([
  RunStepStatuses.succeeded,
  RunStepStatuses.failed,
  RunStepStatuses.skipped,
  RunStepStatuses.canceled,
]);

/** The inbound part of a callback (the token is verified separately, first). */
interface CallbackUpdate {
  runId: string;
  stepIndex: number;
  status: RunCallbackStatus;
  logsUrl?: string;
}

export interface RunServiceDeps {
  runs: RunRepo;
  steps: RunStepRepo;
  events: RunEventRepo;
  commits: CommitRepo;
  configs: CommitConfigRepo;
  /** The executor the loop dispatches steps to (ADR 0004). Prod = the generic
   * executor; tests inject a FakeExecutor. */
  executor: Executor;
  /** Absolute `/api/ext/callback` URL threaded to the executor as the report-back
   * target. Injected (derived from the app origin at the composition root) so tests
   * need no env. */
  callbackUrl: string;
  /** Injection seam: prod passes `@vercel/functions`'s waitUntil so the outbound
   * executor trigger runs after the mutation returns; tests pass a collector so the
   * fire-and-forget dispatch is observable without vi.mock (ADR 0008). */
  waitUntil: (promise: Promise<unknown>) => void;
}

/** The sha-256 hash (hex) of an opaque token — what we store; the plaintext is never persisted. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare of the token's hash against the stored hash — never a `===`
 * on secrets (that leaks length/prefix via timing). Length-guarded because
 * `timingSafeEqual` throws on unequal-length buffers. */
function isTokenValid(token: string, storedHash: string): boolean {
  const provided = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return provided.length === stored.length && timingSafeEqual(provided, stored);
}

/**
 * Owns run policy: turning a commit candidate into a Run pinned to its config
 * snapshot, dispatching it step-by-step through a neutral executor over the
 * trigger → callback → advance loop, plus the workspace-scoped read paths. Anemic
 * domain (ADR 0012) — reaches the DB only through repos, maps their
 * `EntityNotFoundError` to a domain error, and narrows to the wire shape via
 * `.output` at the router. Vendor/adapter words never appear here (ADR 0004);
 * `applyCallback` is the single funnel every executor reports through.
 */
export class RunService {
  constructor(private readonly deps: RunServiceDeps) {}

  /** A commit owned by the workspace, or throw CommitNotFoundError. A commit is
   * NEVER resolved by id alone — always through the workspace-scoped repo join.
   * Mirrors CommitConfigService.requireCommit. */
  private async requireCommit(workspaceId: string, commitId: string) {
    try {
      return await this.deps.commits.getByIdInWorkspace(workspaceId, commitId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new CommitNotFoundError(commitId, { cause: error });
      }
      throw error;
    }
  }

  /** A run owned by the workspace, or throw RunNotFoundError. */
  private async requireRun(workspaceId: string, runId: string) {
    try {
      return await this.deps.runs.getByIdInWorkspace(workspaceId, runId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new RunNotFoundError(runId, { cause: error });
      }
      throw error;
    }
  }

  /** Mark a step dispatched, emit `step.dispatched`, and fire the executor trigger
   * (deferred). Shared by `trigger` (step 0) and `applyCallback`'s advance (step n+1). */
  private async dispatchStep(run: { id: string; workspaceId: string }, index: number, token: string): Promise<void> {
    const step = await this.deps.steps.findByRunAndIndex(run.id, index);
    if (step === undefined) {
      // Invariant: the cursor never points past the materialized steps.
      throw new Error(`run ${run.id} has no step at index ${index}`);
    }
    await this.deps.steps.update(run.workspaceId, step.id, { status: RunStepStatuses.dispatched });
    await this.appendStepEvent(run, RunEventTypes.stepDispatched, index, step.name);

    const ctx: DispatchContext = {
      runId: run.id,
      stepIndex: index,
      callbackUrl: this.deps.callbackUrl,
      callbackToken: token,
    };
    const dispatch: RunStepDispatch = { index, name: step.name, executor: step.executor, with: step.with ?? null };
    // The outbound trigger is fire-and-forget (deferred) — enforcement is the callback,
    // never this call. The step is already marked dispatched; only the handle waits on it.
    this.deps.waitUntil(this.startExecutor(run.workspaceId, step.id, dispatch, ctx));
  }

  /** Fire the executor and record its opaque handle. Runs deferred (waitUntil); a
   * trigger failure is logged and parked — the step stays `dispatched`, no callback
   * will advance it (the reliability escalation is the deferred outbox, ADR 0005). */
  private async startExecutor(
    workspaceId: string,
    stepId: string,
    dispatch: RunStepDispatch,
    ctx: DispatchContext,
  ): Promise<void> {
    try {
      const { handle } = await this.deps.executor.start(dispatch, ctx);
      await this.deps.steps.update(workspaceId, stepId, { handle });
    } catch (error) {
      console.error('[run] executor dispatch failed', error);
    }
  }

  /** Finish a run terminally: set the state + finished_at and append the run event. */
  private async finishRun(
    run: { id: string; workspaceId: string },
    state: typeof RunStates.succeeded | typeof RunStates.failed,
    type: typeof RunEventTypes.runSucceeded | typeof RunEventTypes.runFailed,
  ): Promise<void> {
    await this.deps.runs.update(run.workspaceId, run.id, { state, finishedAt: new Date() });
    await this.deps.events.append({ workspaceId: run.workspaceId, runId: run.id, type, payload: {} });
  }

  private async appendStepEvent(
    run: { id: string; workspaceId: string },
    type: string,
    stepIndex: number,
    name: string,
  ): Promise<void> {
    await this.deps.events.append({
      workspaceId: run.workspaceId,
      runId: run.id,
      type,
      payload: { stepIndex, name },
    });
  }

  /**
   * Create a run for a commit candidate, pinned to its config snapshot, and start it.
   *
   * Guards the config is `present && valid` (else `ConfigNotRunnableError`),
   * materializes the run's steps from the pinned `MoccoConfig` definition, appends
   * `run.created`, marks the run `running`, and dispatches step 0. The plaintext
   * callback token is minted here and threaded to the executor (only its sha-256 is
   * stored); the outbound trigger runs deferred (`waitUntil`) so the mutation returns fast.
   */
  async trigger(workspaceId: string, commitId: string, userId: string) {
    // Resolve workspace-scoped for its authorization side effect (throws
    // CommitNotFoundError for a foreign/unknown commit).
    await this.requireCommit(workspaceId, commitId);

    const snapshot = await this.deps.configs.findByCommitId(commitId);
    if (snapshot === undefined || !snapshot.present || !snapshot.valid) {
      throw new ConfigNotRunnableError(commitId);
    }

    // The stored parsedJson is already a validated MoccoConfig, but re-parse it
    // through the zod SSOT to recover typed steps (never trust the raw jsonb shape).
    const config = moccoConfigSchema.parse(snapshot.parsedJson);

    // Mint the opaque per-run callback token; store only its hash. The plaintext is
    // used once now (threaded to the executor) and never persisted.
    const callbackToken = randomBytes(CALLBACK_TOKEN_BYTES).toString('hex');

    const run = await this.deps.runs.create({
      workspaceId,
      commitId,
      commitConfigId: snapshot.id,
      state: RunStates.queued,
      currentIndex: 0,
      callbackTokenHash: hashToken(callbackToken),
      triggeredByUserId: userId,
      triggerSource: 'manual',
    });

    await this.deps.steps.insertMany(
      config.steps.map((step, index) => ({
        workspaceId,
        runId: run.id,
        stepIndex: index,
        name: step.run,
        executor: step.executor,
        with: step.with ?? null,
        status: RunStepStatuses.pending,
      })),
    );

    await this.deps.events.append({
      workspaceId,
      runId: run.id,
      type: RunEventTypes.runCreated,
      payload: { commitId, stepCount: config.steps.length },
    });

    // Start the run: mark it running and dispatch step 0 (the executor trigger is
    // deferred inside dispatchStep). A step-less config finishes immediately.
    if (config.steps.length === 0) {
      await this.finishRun(run, RunStates.succeeded, RunEventTypes.runSucceeded);
    } else {
      await this.deps.runs.update(workspaceId, run.id, { state: RunStates.running, startedAt: new Date() });
      await this.dispatchStep(run, 0, callbackToken);
    }

    // Return the run reflecting its post-start state (the create() row was `queued`).
    return await this.requireRun(workspaceId, run.id);
  }

  /**
   * The single callback funnel — every executor (generic now, GitHub next slice)
   * reports step progress here. Verifies the per-run token (constant-time) and that
   * the callback targets the run's current cursor, is idempotent on redelivery, then
   * records the step transition and advances the machine.
   */
  async applyCallback(token: string, update: CallbackUpdate): Promise<void> {
    const run = await this.deps.runs.findById(update.runId);
    // Resolve the run, then verify the token — a mismatch (or unknown run) is rejected
    // without revealing which. The ext route turns this into a fixed generic status.
    if (run === undefined || !isTokenValid(token, run.callbackTokenHash)) {
      throw new RunCallbackRejectedError('unknown run or invalid token');
    }

    // Idempotent: a callback after the run already finished is a no-op.
    if (TERMINAL_RUN_STATES.has(run.state)) {
      return;
    }

    const step = await this.deps.steps.findByRunAndIndex(run.id, update.stepIndex);
    // Idempotent: a redelivered callback for an already-settled step is a no-op (its
    // succeeded callback may arrive twice — the second lands after the cursor moved on).
    if (step !== undefined && TERMINAL_STEP_STATUSES.has(step.status)) {
      return;
    }
    // Legal only for the run's current cursor position — a future/foreign index is rejected.
    if (step === undefined || update.stepIndex !== run.currentIndex) {
      throw new RunCallbackRejectedError('step index does not match the run cursor');
    }

    const logsUrl = update.logsUrl ?? null;
    if (update.status === RunCallbackStatuses.running) {
      await this.deps.steps.update(run.workspaceId, step.id, { status: RunStepStatuses.running, logsUrl });
      await this.appendStepEvent(run, RunEventTypes.stepRunning, update.stepIndex, step.name);
      return;
    }
    if (update.status === RunCallbackStatuses.failed) {
      await this.deps.steps.update(run.workspaceId, step.id, { status: RunStepStatuses.failed, logsUrl });
      await this.appendStepEvent(run, RunEventTypes.stepFailed, update.stepIndex, step.name);
      await this.finishRun(run, RunStates.failed, RunEventTypes.runFailed);
      return;
    }
    // succeeded → settle the step, then advance to the next or finish the run.
    await this.deps.steps.update(run.workspaceId, step.id, { status: RunStepStatuses.succeeded, logsUrl });
    await this.appendStepEvent(run, RunEventTypes.stepSucceeded, update.stepIndex, step.name);

    const nextIndex = update.stepIndex + 1;
    const next = await this.deps.steps.findByRunAndIndex(run.id, nextIndex);
    if (next === undefined) {
      await this.finishRun(run, RunStates.succeeded, RunEventTypes.runSucceeded);
      return;
    }
    await this.deps.runs.update(run.workspaceId, run.id, { currentIndex: nextIndex });
    await this.dispatchStep(run, nextIndex, token);
  }

  /** A run and its materialized steps, workspace-scoped. */
  async get(workspaceId: string, runId: string) {
    const run = await this.requireRun(workspaceId, runId);
    const steps = await this.deps.steps.listByRun(workspaceId, runId);
    return { run, steps };
  }

  /** A run plus its progression events with `seq > sinceSeq` — the live poll read. */
  async observe(workspaceId: string, runId: string, sinceSeq: bigint) {
    const run = await this.requireRun(workspaceId, runId);
    const events = await this.deps.events.listSince(workspaceId, runId, sinceSeq);
    return { run, events };
  }
}
