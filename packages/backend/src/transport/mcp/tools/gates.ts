// `mocco_gates_resume` — resume or reject a run paused at a gate, as the caller.
//
// The same three locks as `mocco_approvals_vote`, from the same place (`tools/deciding.ts`):
// the `approvals:write` scope, the workspace's opt-in, and a confirmation the person
// answers in their client. Then `GateService.resume` decides exactly as it does for the
// console — the gate must be the run's current one, the run's triggerer cannot resume it
// when the gate says so, the caller needs one of its roles, and gets one vote.
//
// It needs a person's token for the same reason the vote does (ADR 0025): resuming a gate
// can release a production deploy, and the audit chain must name someone who could have
// been asked.
import { resumeDecisionSchema, ResumeDecisions } from '@mocco/common/governance';
import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  DuplicateVoteError,
  GateNotCurrentError,
  NotAuthorizedToResumeError,
  PreventSelfError,
  ReasonRequiredError,
} from '@backend/domain/governance/errors';
import {
  CONFIRM,
  confirmationSchema,
  openDecision,
  refused,
  requireApprovalsWrite,
} from '@backend/transport/mcp/tools/deciding';
import { asJson, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { GateService } from '@backend/domain/governance/GateService';
import type { DecidingToolDeps } from '@backend/transport/mcp/tools/deciding';
import type { GateRequirements, ResumeDecision } from '@mocco/common/governance';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface GateToolDeps extends DecidingToolDeps {
  gates: Pick<GateService, 'getPending' | 'resume'>;
}

export const RESUME_TOOL = 'mocco_gates_resume';

const resumeInput = z.object({
  runId: z.string().describe('The run id, as `mocco_runs_search` returns it.'),
  gateItemIndex: z
    .number()
    .int()
    .nonnegative()
    .describe("Which gate: the `itemIndex` of the run's `waitingOn`, as `mocco_runs_get` returns it."),
  decision: resumeDecisionSchema.describe(
    '`resume` lets the run continue once the gate has the votes it needs; `reject` halts the run. One vote per person, and it cannot be changed.',
  ),
  reason: z.string().min(1).optional().describe('Why. Some gates require one; it is recorded with the vote.'),
  workspaceId: workspaceArg,
});

export type ResumeArgs = z.infer<typeof resumeInput>;

/** What the confirmation showed, echoed back signed. Parsed, because what comes back
 * from the client is input like any other. The tool names itself, so a vote's state
 * cannot be replayed here. */
const resumeConfirmationSchema = z.object({
  tool: z.literal(RESUME_TOOL),
  workspaceId: z.string(),
  runId: z.string(),
  gateItemIndex: z.number(),
  decision: resumeDecisionSchema,
  reason: z.string().nullable(),
});
type ResumeConfirmation = z.infer<typeof resumeConfirmationSchema>;

const confirmSchema = confirmationSchema('Record this decision');

/**
 * What the model is told when the service refuses: the service's own reason, plus what to
 * do about it. Anything not listed is rethrown — an unexpected failure is not something to
 * explain away.
 */
function resumeRefusal(error: unknown): CallToolResult {
  if (error instanceof GateNotCurrentError) {
    return refused(
      `${error.message}. The run is not paused there: it moved on, was decided, or is not in this workspace. mocco_runs_get shows what it is waiting on.`,
    );
  }
  if (error instanceof PreventSelfError) {
    return refused(`${error.message}. Someone other than the person who triggered the run has to.`);
  }
  if (error instanceof NotAuthorizedToResumeError) {
    return refused(
      `${error.message}. Someone in one of the roles the gate requires has to; mocco_runs_get lists them.`,
    );
  }
  if (error instanceof ReasonRequiredError) {
    return refused(`${error.message}. Call again with a reason.`);
  }
  if (error instanceof DuplicateVoteError) {
    return refused(`${error.message}. A vote cannot be changed.`);
  }
  throw error;
}

/** The gate's requirements in a line a person reads. */
function describeRequirements(requirements: GateRequirements): string {
  const roles = requirements.resume.map(each => `${each.count} × ${each.role}`).join(' and ');
  return [
    roles,
    ...(requirements.prevent_self ? ['not the person who triggered the run'] : []),
    ...(requirements.reason_required ? ['a reason'] : []),
  ].join('; ');
}

/** What the person is asked: the decision, and exactly which run and gate it decides. */
function confirmationMessage(
  pending: Awaited<ReturnType<GateService['getPending']>>,
  decision: ResumeDecision,
  reason: string | null,
): string {
  const { run, repo, commit, gate } = pending;
  const subject = commit.message.split('\n', 1)[0] ?? '';
  return [
    decision === ResumeDecisions.resume
      ? `Resume this run past its gate as you?`
      : `Reject this run at its gate as you? Rejecting halts the run.`,
    `Repository: ${repo.owner}/${repo.name}`,
    subject === ''
      ? `Commit: ${commit.sha} on ${commit.branch}`
      : `Commit: ${commit.sha} on ${commit.branch} — ${subject}`,
    `Gate: ${gate.name} (item ${gate.itemIndex})`,
    `Requires: ${describeRequirements(gate.requirements)}`,
    `Reason: ${reason ?? '(none)'}`,
    `Run: ${run.id}`,
  ].join('\n');
}

/**
 * Resume or reject a paused run's current gate as the caller, once they have confirmed it.
 *
 * The first call asks: it returns `input_required` with a confirmation naming the run and
 * the gate, and a signed state recording what was shown. The retry carries the person's
 * answer; only an accepted "yes" for the same decision reaches `GateService.resume`.
 */
export async function resumeGate(
  deps: GateToolDeps,
  args: ResumeArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  const opened = await openDecision(deps, ctx, args.workspaceId, {
    verb: 'resume or reject runs',
    doing: 'Resuming or rejecting a run',
  });
  if ('content' in opened) {
    return opened;
  }
  const { userId, workspaceId, confirmations } = opened;
  const asked: ResumeConfirmation = {
    tool: RESUME_TOOL,
    workspaceId,
    runId: args.runId,
    gateItemIndex: args.gateItemIndex,
    decision: args.decision,
    reason: args.reason ?? null,
  };

  try {
    const echoed = ctx.mcpReq.requestState();
    if (echoed === undefined) {
      const pending = await deps.gates.getPending(workspaceId, args.runId, args.gateItemIndex);
      return inputRequired({
        inputRequests: {
          [CONFIRM]: inputRequired.elicit({
            message: confirmationMessage(pending, args.decision, asked.reason),
            requestedSchema: confirmSchema,
          }),
        },
        requestState: await confirmations.mint(asked, ctx),
      });
    }

    // The state is signed and bound to this person; it must also be this decision, or a
    // confirmation of one could carry another.
    const shown = resumeConfirmationSchema.safeParse(echoed);
    if (
      !shown.success ||
      shown.data.workspaceId !== asked.workspaceId ||
      shown.data.runId !== asked.runId ||
      shown.data.gateItemIndex !== asked.gateItemIndex ||
      shown.data.decision !== asked.decision ||
      shown.data.reason !== asked.reason
    ) {
      return refused('That confirmation was for a different decision. Call again without it to be asked afresh.');
    }
    // Declined, cancelled, missing, or an accepted "no" all read the same: nothing recorded.
    if (acceptedContent(ctx.mcpReq.inputResponses, CONFIRM, confirmSchema)?.confirm !== true) {
      return asJson({ recorded: false, reason: 'You did not confirm, so nothing was recorded.' });
    }

    const { run, gate } = await deps.gates.resume(
      workspaceId,
      args.runId,
      args.gateItemIndex,
      userId,
      args.decision,
      args.reason,
    );
    // The gate may still be pending: one vote does not always satisfy an N-of-M gate.
    return asJson({ recorded: true, runId: run.id, run: run.state, gate: { name: gate.name, state: gate.state } });
  } catch (error) {
    return resumeRefusal(error);
  }
}

export function registerGateTools(server: McpServer, deps: GateToolDeps): void {
  server.registerTool(
    RESUME_TOOL,
    {
      title: 'Resume or reject a paused run',
      description:
        "Vote to resume or reject the gate a run is paused at, as the signed-in person. The person is asked to confirm in their client before the vote is recorded. Only works where the workspace allows agents to decide, and only within the gate's required roles. Find the run and gate with mocco_runs_get.",
      inputSchema: resumeInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      scopeChallenge: requireApprovalsWrite(
        'Resuming a run needs your permission for this app to approve and reject as you',
      ),
    },
    async (args, ctx) => await resumeGate(deps, args, ctx),
  );
}
