import { z } from 'zod';

/**
 * Run lifecycle states: `queued → running → (succeeded | failed | canceled)`, plus
 * the gate states `awaiting_gate` (paused at a gate, resumable) and `rejected` (a
 * gate reject halted the run — terminal). Modeled as an `as const` object + derived
 * union (constants over enums) so a new state is an additive change here.
 */
export const RunStates = {
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
  awaitingGate: 'awaiting_gate',
  rejected: 'rejected',
} as const;
export type RunState = (typeof RunStates)[keyof typeof RunStates];
export const runStateSchema = z.enum(Object.values(RunStates) as [RunState, ...RunState[]]);

/** Run-step lifecycle: `pending → dispatched → running → (succeeded | failed | skipped | canceled)`. */
export const RunStepStatuses = {
  pending: 'pending',
  dispatched: 'dispatched',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  skipped: 'skipped',
  canceled: 'canceled',
} as const;
export type RunStepStatus = (typeof RunStepStatuses)[keyof typeof RunStepStatuses];
export const runStepStatusSchema = z.enum(Object.values(RunStepStatuses) as [RunStepStatus, ...RunStepStatus[]]);

/** How a run was triggered — the SSOT for `trigger_source` (no magic strings).
 * `manual` = a member clicked Run; adapter/scheduled sources land with later slices. */
export const TriggerSources = { manual: 'manual' } as const;
export type TriggerSource = (typeof TriggerSources)[keyof typeof TriggerSources];

/**
 * Executor adapter ids (ADR 0004) — the SSOT a step's `executor` string is matched
 * against at dispatch. Keys are camelCase; values follow the on-the-wire config
 * casing (`github-actions` is kebab, an external contract). Modeled as an `as const`
 * object + derived union (constants over enums). `generic` is the built-in adapter;
 * `githubActions` is defined here but only registered at the composition root once
 * the GitHub adapter lands (slice 6 PR2) — an unregistered id fails a run closed.
 */
export const ExecutorIds = {
  generic: 'generic',
  githubActions: 'github-actions',
} as const;
export type ExecutorId = (typeof ExecutorIds)[keyof typeof ExecutorIds];
export const executorIdSchema = z.enum(Object.values(ExecutorIds) as [ExecutorId, ...ExecutorId[]]);

/**
 * A run of a commit candidate, pinned to the commit and its config snapshot.
 * `callbackTokenHash` is deliberately absent: it is a secret the egress filter
 * (`.output(runSchema)`) strips from the row so it never crosses the wire.
 */
export const runSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  commitId: z.uuid(),
  commitConfigId: z.uuid(),
  state: runStateSchema,
  currentIndex: z.number().int(),
  triggeredByUserId: z.uuid().nullable(),
  triggerSource: z.string(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type RunDto = z.infer<typeof runSchema>;

/** A materialized step of a run. `with` is free-form adapter options (ADR 0004); `handle` is an opaque adapter handle. */
export const runStepSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  stepIndex: z.number().int(),
  name: z.string(),
  executor: z.string(),
  with: z.record(z.string(), z.unknown()).nullable(),
  status: runStepStatusSchema,
  handle: z.string().nullable(),
  logsUrl: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type RunStepDto = z.infer<typeof runStepSchema>;

/**
 * A single run progression event. `seq` is a DB `bigserial` — it exceeds JS's
 * safe-integer range over time, so it stays a string end-to-end (the same treatment
 * as `commitSchema.seq`) and is the `sinceSeq` cursor for the live poll.
 */
export const runEventSchema = z.object({
  seq: z.string(),
  runId: z.uuid(),
  type: z.string(),
  payload: z.unknown(),
  createdAt: z.date(),
});
export type RunEventDto = z.infer<typeof runEventSchema>;

/**
 * The status an executor reports for a step over the callback: a strict subset of
 * the step lifecycle an adapter is allowed to drive from outside. `dispatched` is
 * ours (set at trigger); terminal-branching states like `skipped`/`canceled` are
 * driven by the core, never a callback.
 */
export const RunCallbackStatuses = {
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
} as const;
export type RunCallbackStatus = (typeof RunCallbackStatuses)[keyof typeof RunCallbackStatuses];
export const runCallbackStatusSchema = z.enum(
  Object.values(RunCallbackStatuses) as [RunCallbackStatus, ...RunCallbackStatus[]],
);

/**
 * The inbound callback an executor POSTs to `/api/ext/callback` as a step
 * progresses. `token` is the opaque per-run secret (the auth — sha-256-compared
 * against the run's stored hash); the rest identifies the step and its new status.
 */
export const runCallbackSchema = z.object({
  runId: z.uuid(),
  stepIndex: z.number().int().nonnegative(),
  status: runCallbackStatusSchema,
  token: z.string().min(1),
  logsUrl: z.string().optional(),
});
export type RunCallbackDto = z.infer<typeof runCallbackSchema>;

/**
 * The neutral dispatch context handed to an executor at `start` and echoed back on
 * every callback: which step of which run, where to call back, and the per-run
 * token to authenticate with. Carries NO adapter/vendor words (ADR 0004). Also the
 * wire body the generic-executor serverless fn parses at `/api/ext/executor/generic`.
 */
export const dispatchContextSchema = z.object({
  runId: z.uuid(),
  stepIndex: z.number().int().nonnegative(),
  callbackUrl: z.url(),
  callbackToken: z.string().min(1),
});
export type DispatchContext = z.infer<typeof dispatchContextSchema>;
