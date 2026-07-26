// The generic executor — the first (and, this slice, only) Executor adapter
// (ADR 0004). It models an external executor with zero external accounts: `start`
// fires a trigger (a fire-and-forget JSON POST) to a serverless fn carrying the
// callback context, and returns an opaque handle. It does NOTHING else — no
// enforcement, no waiting; progress arrives later over the callback funnel.
import type { Executor, HttpPost, RunStepDispatch } from '@backend/domain/execution/ports';
import type { DispatchContext } from '@mocco/common/execution';

export interface GenericExecutorDeps {
  /** The generic-executor serverless fn URL (derived from the app origin). */
  endpoint: string;
  /** Outbound-HTTP seam (prod = `postJson`; tests inject a recorder). */
  post: HttpPost;
}

export class GenericExecutor implements Executor {
  constructor(private readonly deps: GenericExecutorDeps) {}

  /** Fire the trigger and return a deterministic opaque handle. The `dispatch` step
   * detail is unused by this adapter (a real adapter would forward it); only the
   * callback context needs to travel, so the fn knows where/how to report back. */
  async start(_dispatch: RunStepDispatch, ctx: DispatchContext): Promise<{ handle: string }> {
    await this.deps.post(this.deps.endpoint, ctx);
    return { handle: `generic:${ctx.runId}:${ctx.stepIndex}` };
  }
}
