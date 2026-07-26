// The generic-executor serverless fn body (the thing `/api/ext/executor/generic`
// runs). It "executes" a trivial bounded step: report `running`, then `succeeded`,
// by POSTing callbacks to the run's callback URL, authed by the per-run token it
// was handed. No real work, no artificial delay — serverless-safe and deterministic.
import { RunCallbackStatuses } from '@mocco/common/execution';

import type { HttpPost } from '@backend/domain/execution/ports';
import type { DispatchContext, RunCallbackDto } from '@mocco/common/execution';

/** Post one callback for this step, echoing the run/step identity and the token. */
async function report(ctx: DispatchContext, status: RunCallbackDto['status'], post: HttpPost): Promise<void> {
  const body: RunCallbackDto = {
    runId: ctx.runId,
    stepIndex: ctx.stepIndex,
    status,
    token: ctx.callbackToken,
  };
  await post(ctx.callbackUrl, body);
}

/** Simulate a step end-to-end: `running` then `succeeded`. Sequential so the core
 * observes the same ordering a real executor would produce. */
export async function simulateStep(ctx: DispatchContext, post: HttpPost): Promise<void> {
  await report(ctx, RunCallbackStatuses.running, post);
  await report(ctx, RunCallbackStatuses.succeeded, post);
}
