// Provider-agnostic executor port (ADR 0004). NO adapter/vendor words here — an
// adapter (the generic executor now; the GitHub adapter next slice) implements
// `Executor` and speaks the neutral trigger → callback → advance loop. The core
// hands a step to run plus a `DispatchContext` (where to call back, with what
// token) and gets back an opaque handle; all enforcement lives in the callback.
import type { DispatchContext } from '@mocco/common/execution';

/** A single step to run, projected from the run's materialized step row. The
 * neutral shape an executor is handed — no run-internal columns leak. */
export interface RunStepDispatch {
  index: number;
  name: string;
  executor: string;
  with: Record<string, unknown> | null;
}

/** Fires a step at an executor. Returns an opaque `handle` (the core stores it on
 * the step, keeping adapter words out). The trigger is fire-and-forget: progress
 * arrives later over the callback, never as this promise's result. */
export interface Executor {
  start(dispatch: RunStepDispatch, ctx: DispatchContext): Promise<{ handle: string }>;
}

/** A JSON POST seam — the only outbound-HTTP surface of the execution loop, kept
 * behind a neutral function type so the composition root binds `fetch` and tests
 * inject a recording fake (no vi.mock; ADR 0008). */
export type HttpPost = (url: string, body: unknown) => Promise<void>;
