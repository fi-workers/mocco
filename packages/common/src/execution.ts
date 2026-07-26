import { z } from 'zod';

/**
 * Run lifecycle states: `queued → running → (succeeded | failed | canceled)`.
 * Gate states (`awaiting_gate`, `rejected`) land in the gates slice. Modeled as an
 * `as const` object + derived union (constants over enums) so a new state is an
 * additive change here.
 */
export const RunStates = {
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
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
