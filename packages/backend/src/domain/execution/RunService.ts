import { randomBytes } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { RunCallbackStatuses, RunStates, RunStepStatuses, TriggerSources } from '@mocco/common/execution';
import { moccoConfigSchema, PipelineItemKinds } from '@mocco/common/mocco-config';

import { hashToken, isTokenValid } from '@backend/domain/execution/callback-token';
import {
  ConfigNotRunnableError,
  RunCallbackRejectedError,
  RunNotFoundError,
  UnknownExecutorError,
} from '@backend/domain/execution/errors';
import { CommitNotFoundError } from '@backend/domain/integration/errors';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { Executor, RunStepDispatch } from '@backend/domain/execution/ports';
import type { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import type { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import type { RunRepo } from '@backend/domain/execution/repos/run.repo';
import type { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import type { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import type { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import type { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import type { DispatchContext, RunCallbackStatus, RunState, RunStepStatus } from '@mocco/common/execution';
import type { GateRequirements } from '@mocco/common/governance';
import type { MoccoConfig } from '@mocco/common/mocco-config';

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
  gatePending: 'gate.pending',
  runSucceeded: 'run.succeeded',
  runFailed: 'run.failed',
} as const;

/** Run states from which no callback can advance the machine — a redelivered final
 * callback after the run finished (or was gate-rejected) is a no-op. */
const TERMINAL_RUN_STATES = new Set<RunState>([
  RunStates.succeeded,
  RunStates.failed,
  RunStates.canceled,
  RunStates.rejected,
]);

/** A pinned config's pipeline flattened to positional items: a step to dispatch or a
 * gate to pause at. `index` is the item's position — the shared cursor namespace for
 * run_steps (`step_index`) and run_gates (`item_index`). */
type NormalizedItem =
  | {
      kind: typeof PipelineItemKinds.step;
      index: number;
      name: string;
      executor: string;
      with: Record<string, unknown> | null;
    }
  | { kind: typeof PipelineItemKinds.gate; index: number; name: string; requirements: GateRequirements };

/** Flatten a v1 (all steps) or v2 (steps + gates) config into positional items. v1
 * items are always steps — its behaviour is unchanged. */
function normalizeItems(config: MoccoConfig): NormalizedItem[] {
  if (config.version === 1) {
    return config.steps.map((step, index) => ({
      kind: PipelineItemKinds.step,
      index,
      name: step.run,
      executor: step.executor,
      with: step.with ?? null,
    }));
  }
  return config.steps.map((item, index) =>
    item.kind === PipelineItemKinds.gate
      ? {
          kind: PipelineItemKinds.gate,
          index,
          name: item.name,
          requirements: {
            resume: item.resume,
            prevent_self: item.prevent_self ?? false,
            reason_required: item.reason_required ?? false,
          },
        }
      : { kind: PipelineItemKinds.step, index, name: item.run, executor: item.executor, with: item.with ?? null },
  );
}

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
  /** Gate items materialized at trigger; the advance loop pauses when the cursor
   * points at one. Owned by the governance domain (cross-domain repo injection,
   * like `commits`/`configs`). */
  runGates: RunGateRepo;
  /** Votes on a run's gates — read into the run-detail payload for the gate card. */
  resumes: ResumeRepo;
  commits: CommitRepo;
  configs: CommitConfigRepo;
  /** The executor registry the loop dispatches steps through, keyed by executor id
   * (ADR 0004; the SSOT is `ExecutorIds`). `dispatchStep` resolves a step's adapter
   * by its `executor` string; a miss fails the run closed (never a silent no-op).
   * Prod registers the generic executor (the GitHub adapter lands in slice 6 PR2);
   * tests register a FakeExecutor under the ids they exercise. */
  executors: ReadonlyMap<string, Executor>;
  /** Absolute `/api/ext/callback` URL threaded to the executor as the report-back
   * target. Injected (derived from the app origin at the composition root) so tests
   * need no env. */
  callbackUrl: string;
  /** Injection seam: prod passes `@vercel/functions`'s waitUntil so the outbound
   * executor trigger runs after the mutation returns; tests pass a collector so the
   * fire-and-forget dispatch is observable without vi.mock (ADR 0008). */
  waitUntil: (promise: Promise<unknown>) => void;
  /** The append-only audit chain (slice 8). `trigger` appends `run.triggered` here;
   * fail-open (AuditService.record swallows + logs), so an audit failure never breaks
   * the trigger — the run is already durably created and started. */
  audit: AuditService;
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

  /** Resolve the step's executor from the registry, fire it, and record its opaque
   * handle. Runs deferred (waitUntil). An UNKNOWN executor id is fail-closed (ADR
   * 0004): a throw here would only be logged and the step would stall `dispatched`
   * forever — a silent no-op the spec forbids — so the run is actively failed
   * instead (see `failStepAndRun`). A dispatch failure for a KNOWN executor is
   * logged and parked — the step stays `dispatched`, no callback will advance it
   * (the reliability escalation is the deferred outbox, ADR 0005). */
  private async startExecutor(
    workspaceId: string,
    stepId: string,
    dispatch: RunStepDispatch,
    ctx: DispatchContext,
  ): Promise<void> {
    const executor = this.deps.executors.get(dispatch.executor);
    if (executor === undefined) {
      await this.failStepAndRun({ id: ctx.runId, workspaceId }, stepId, dispatch);
      return;
    }
    try {
      const { handle } = await executor.start(dispatch, ctx);
      await this.deps.steps.update(workspaceId, stepId, { handle });
    } catch (error) {
      console.error('[run] executor dispatch failed', error);
    }
  }

  /** Fail-closed for a step whose `executor` id has no registered adapter: fail the
   * step, emit `step.failed` (naming the unknown executor) + `run.failed`, and log.
   * Mirrors `applyCallback`'s failed-step path + `finishRun` — the same repos/events
   * every terminal failure uses — so an unknown executor surfaces as a real run
   * failure in the timeline, never a stalled step. */
  private async failStepAndRun(
    run: { id: string; workspaceId: string },
    stepId: string,
    dispatch: RunStepDispatch,
  ): Promise<void> {
    const error = new UnknownExecutorError(dispatch.executor);
    console.error(`[run] fail-closed: ${error.message}`);
    await this.deps.steps.update(run.workspaceId, stepId, { status: RunStepStatuses.failed });
    await this.deps.events.append({
      workspaceId: run.workspaceId,
      runId: run.id,
      type: RunEventTypes.stepFailed,
      payload: { stepIndex: dispatch.index, name: dispatch.name, executor: dispatch.executor },
    });
    await this.finishRun(run, RunStates.failed, RunEventTypes.runFailed);
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
   * Advance the cursor to `index` and act on the item there: a GATE pauses the run
   * (`awaiting_gate`, the gate stays `pending`, emit `gate.pending` — no dispatch); a
   * STEP is dispatched (`running`); nothing there means the pipeline is done (finish
   * succeeded). Shared by `trigger` (item 0 may be a gate), `applyCallback`'s advance
   * (the next item may be a gate), and `resumeFromGate` (continue past a gate).
   */
  private async advance(run: { id: string; workspaceId: string }, index: number, token: string): Promise<void> {
    const gate = await this.deps.runGates.findByRunAndIndex(run.id, index);
    if (gate !== undefined) {
      await this.deps.runs.update(run.workspaceId, run.id, {
        state: RunStates.awaitingGate,
        currentIndex: index,
      });
      await this.appendGateEvent(run, RunEventTypes.gatePending, index, gate.name);
      return;
    }
    const step = await this.deps.steps.findByRunAndIndex(run.id, index);
    if (step === undefined) {
      // Ran off the end of the pipeline — every item is done.
      await this.finishRun(run, RunStates.succeeded, RunEventTypes.runSucceeded);
      return;
    }
    await this.deps.runs.update(run.workspaceId, run.id, { state: RunStates.running, currentIndex: index });
    await this.dispatchStep(run, index, token);
  }

  private async appendGateEvent(
    run: { id: string; workspaceId: string },
    type: string,
    itemIndex: number,
    name: string,
  ): Promise<void> {
    await this.deps.events.append({
      workspaceId: run.workspaceId,
      runId: run.id,
      type,
      payload: { itemIndex, name },
    });
  }

  /**
   * Continue a run once its current gate is resumed (called by GateService). Advances
   * the cursor PAST the gate and acts on the next item (dispatch, pause at the next
   * gate, or finish). A fresh callback token is minted for the next step — no step is
   * in flight at a gate, so rotating it is safe (the plaintext is never persisted).
   */
  async resumeFromGate(run: { id: string; workspaceId: string }, gateItemIndex: number): Promise<void> {
    const token = randomBytes(CALLBACK_TOKEN_BYTES).toString('hex');
    await this.deps.runs.update(run.workspaceId, run.id, { callbackTokenHash: hashToken(token) });
    await this.advance(run, gateItemIndex + 1, token);
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
    // through the zod SSOT to recover typed items (never trust the raw jsonb shape),
    // then flatten v1/v2 into positional items (steps to dispatch, gates to pause at).
    const items = normalizeItems(moccoConfigSchema.parse(snapshot.parsedJson));

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
      triggerSource: TriggerSources.manual,
    });

    // Materialize step items → run_steps and gate items → run_gates, each keyed by its
    // item position (the shared cursor index). A gate snapshots its requirements.
    await this.deps.steps.insertMany(
      items
        .filter(item => item.kind === PipelineItemKinds.step)
        .map(item => ({
          workspaceId,
          runId: run.id,
          stepIndex: item.index,
          name: item.name,
          executor: item.executor,
          with: item.with,
          status: RunStepStatuses.pending,
        })),
    );
    await this.deps.runGates.insertMany(
      items
        .filter(item => item.kind === PipelineItemKinds.gate)
        .map(item => ({
          workspaceId,
          runId: run.id,
          itemIndex: item.index,
          name: item.name,
          requirements: item.requirements,
        })),
    );

    await this.deps.events.append({
      workspaceId,
      runId: run.id,
      type: RunEventTypes.runCreated,
      payload: { commitId, stepCount: items.filter(item => item.kind === PipelineItemKinds.step).length },
    });

    // Start the run: advance from item 0 (dispatch a step, pause at a gate, or — an
    // item-less config — finish immediately). The executor trigger is deferred inside
    // dispatchStep.
    if (items.length === 0) {
      await this.finishRun(run, RunStates.succeeded, RunEventTypes.runSucceeded);
    } else {
      await this.deps.runs.update(workspaceId, run.id, { startedAt: new Date() });
      await this.advance(run, 0, callbackToken);
    }

    // Audit AFTER the run is durably created + started — fail-open (never breaks the
    // trigger). The actor is the triggerer; the subject is the run.
    await this.deps.audit.record(workspaceId, {
      actorUserId: userId,
      action: AuditActions.runTriggered,
      subjectType: 'run',
      subjectId: run.id,
      payload: { commitId },
    });

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
    // succeeded → settle the step, then advance to the next item (dispatch a step,
    // pause at a gate, or finish the run).
    await this.deps.steps.update(run.workspaceId, step.id, { status: RunStepStatuses.succeeded, logsUrl });
    await this.appendStepEvent(run, RunEventTypes.stepSucceeded, update.stepIndex, step.name);
    await this.advance(run, update.stepIndex + 1, token);
  }

  /** A run with its materialized steps, gates, and the votes cast — workspace-scoped.
   * The gate card renders progress from the gates + resumes. */
  async get(workspaceId: string, runId: string) {
    const run = await this.requireRun(workspaceId, runId);
    const steps = await this.deps.steps.listByRun(workspaceId, runId);
    const gates = await this.deps.runGates.findByRun(workspaceId, runId);
    const resumes = await this.deps.resumes.listByRun(workspaceId, runId);
    return { run, steps, gates, resumes };
  }

  /** A run plus its progression events with `seq > sinceSeq`, and its gates + votes —
   * the live poll read (the gate card re-renders gate progress in place). */
  async observe(workspaceId: string, runId: string, sinceSeq: bigint) {
    const run = await this.requireRun(workspaceId, runId);
    const events = await this.deps.events.listSince(workspaceId, runId, sinceSeq);
    const gates = await this.deps.runGates.findByRun(workspaceId, runId);
    const resumes = await this.deps.resumes.listByRun(workspaceId, runId);
    return { run, events, gates, resumes };
  }
}
