// Test-only Executor that records what it was asked to dispatch instead of firing
// a real trigger (test infra, mirrors infra/db/testing/pglite.ts — never imported
// by production code). Constructor-injected into RunService in tests, so the
// service exercises its real dispatch path without any network or vi.mock.
import type { Executor, RunStepDispatch } from '@backend/domain/execution/ports';
import type { DispatchContext } from '@mocco/common/execution';

export interface RecordedDispatch {
  dispatch: RunStepDispatch;
  ctx: DispatchContext;
}

export class FakeExecutor implements Executor {
  readonly dispatches: RecordedDispatch[] = [];

  async start(dispatch: RunStepDispatch, ctx: DispatchContext): Promise<{ handle: string }> {
    this.dispatches.push({ dispatch, ctx });
    return { handle: `fake:${ctx.runId}:${ctx.stepIndex}` };
  }
}
