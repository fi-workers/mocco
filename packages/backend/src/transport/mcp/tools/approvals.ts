// `mocco_approvals_*` — what is waiting on a human, and on whom, and the vote itself.
//
// The reads are open to any signed-in person. `mocco_approvals_vote` is a decision, so
// it sits behind three things the reads do not need, each refusing on its own: the
// `approvals:write` scope on the token, the workspace's opt-in (Settings → Agents), and a
// confirmation the person answers in their client before the vote is cast. None of them
// replaces the role check — `ApprovalService.vote` still decides who may vote, as it does
// for the console.
//
// These tools exist on MCP and not on `/v1` for a structural reason, not an arbitrary
// one: an approval request is workspace-scoped with an opaque subject, so it cannot be
// narrowed to the project an API key speaks for. A person in a workspace is exactly the
// right unit of scope, and that is who is calling here.
import { approvalDecisionSchema, ApprovalStates } from '@mocco/common/governance';
import { McpScopes } from '@mocco/common/mcp';
import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  ApprovalReasonRequiredError,
  DuplicateApprovalVoteError,
  NotAuthorizedToApproveError,
  SelfApprovalError,
} from '@backend/domain/governance/errors';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import type { Confirmations } from '@backend/transport/mcp/confirmation';
import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  ScopeChallengeHandler,
  ServerContext,
} from '@modelcontextprotocol/server';

export interface ApprovalToolDeps {
  approvals: Pick<ApprovalService, 'list' | 'get' | 'vote'>;
  scope: WorkspaceScope;
  settings: Pick<McpSettingsService, 'agentsMayDecide'>;
  /** Signs the confirmation round trip. Absent without AUTH_SECRET, and then the deciding
   * tools refuse: a confirmation that cannot be verified is no confirmation. */
  confirmations: Confirmations | undefined;
}

const searchInput = z.object({
  workspaceId: workspaceArg,
  state: z
    .enum([ApprovalStates.pending, ApprovalStates.approved, ApprovalStates.rejected, ApprovalStates.expired])
    .default(ApprovalStates.pending)
    .describe('Only requests in this state.'),
  subjectType: z.string().optional().describe('Only requests about this kind of subject, e.g. `ota.channel_policy`.'),
});

const readInput = z.object({
  requestId: z.string().describe('The request id, as `mocco_approvals_search` returns it.'),
  workspaceId: workspaceArg,
});

export type SearchApprovalsArgs = z.infer<typeof searchInput>;
export type GetApprovalArgs = z.infer<typeof readInput>;

export async function searchApprovals(deps: ApprovalToolDeps, args: SearchApprovalsArgs, userId: string) {
  const workspace = await deps.scope.resolve(userId, args.workspaceId);
  const requests = await deps.approvals.list(workspace, {
    state: args.state,
    ...(args.subjectType !== undefined && { subjectType: args.subjectType }),
  });
  return {
    requests: requests.map(request => ({
      id: request.id,
      kind: request.kind,
      subject: { type: request.subjectType, id: request.subjectId },
      state: request.state,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    })),
  };
}

export async function getApproval(deps: ApprovalToolDeps, args: GetApprovalArgs, userId: string) {
  const workspace = await deps.scope.resolve(userId, args.workspaceId);
  const { request, votes } = await deps.approvals.get(workspace, args.requestId);
  return {
    id: request.id,
    kind: request.kind,
    subject: { type: request.subjectType, id: request.subjectId },
    state: request.state,
    // The pinned change: what will be applied if this is approved, and nothing else.
    action: request.action,
    requirements: request.requirements,
    requestedByUserId: request.requestedByUserId,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    resolvedAt: request.resolvedAt,
    votes: votes.map(vote => ({
      userId: vote.userId,
      decision: vote.decision,
      reason: vote.reason,
      createdAt: vote.createdAt,
    })),
  };
}

export const VOTE_TOOL = 'mocco_approvals_vote';

const voteInput = z.object({
  requestId: z.string().describe('The request id, as `mocco_approvals_search` returns it.'),
  decision: approvalDecisionSchema.describe('`approve` or `reject`. One vote per person, and it cannot be changed.'),
  reason: z.string().min(1).optional().describe('Why. Some requests require one; it is recorded with the vote.'),
  workspaceId: workspaceArg,
});

export type VoteArgs = z.infer<typeof voteInput>;

/** What the confirmation showed, echoed back signed. Parsed, because what comes back
 * from the client is input like any other. */
const voteConfirmationSchema = z.object({
  tool: z.literal(VOTE_TOOL),
  workspaceId: z.string(),
  requestId: z.string(),
  decision: approvalDecisionSchema,
  reason: z.string().nullable(),
});
type VoteConfirmation = z.infer<typeof voteConfirmationSchema>;

/** The person's answer. A boolean field, because a form-mode elicitation can carry one
 * and every client renders it as the yes/no it is. */
const CONFIRM = 'confirm';
const confirmSchema = z.object({ confirm: z.boolean().describe('Cast this vote') });

/** A refusal the model reads and can act on. */
const refused = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/**
 * What the model is told when the service refuses the vote: the service's own reason,
 * plus what to do about it. Anything not listed is rethrown — an unexpected failure is
 * not something to explain away.
 */
function voteRefusal(error: unknown): CallToolResult {
  if (error instanceof ApprovalNotFoundError) {
    return refused(`${error.message}. Find the id with mocco_approvals_search.`);
  }
  if (error instanceof ApprovalNotPendingError) {
    return refused(`${error.message}: it was decided or expired. mocco_approvals_get shows how it ended.`);
  }
  if (error instanceof DuplicateApprovalVoteError) {
    return refused(`${error.message}. A vote cannot be changed.`);
  }
  if (error instanceof NotAuthorizedToApproveError) {
    return refused(
      `${error.message}. Someone in one of the required roles has to vote; mocco_approvals_get lists them.`,
    );
  }
  if (error instanceof SelfApprovalError) {
    return refused(`${error.message}. Someone other than the requester has to approve it.`);
  }
  if (error instanceof ApprovalReasonRequiredError) {
    return refused(`${error.message}. Call again with a reason.`);
  }
  throw error;
}

/** The deciding tools need `approvals:write`. A token without it is challenged for it
 * (HTTP 403, `insufficient_scope`) — every scope it already has plus this one, because
 * the client re-authorizes with exactly the set the challenge names. */
// eslint-disable-next-line sonarjs/function-return-type -- the SDK's contract: a challenge, or undefined for none
const requireApprovalsWrite: ScopeChallengeHandler = ({ authInfo }) => {
  if (authInfo === undefined || authInfo.scopes.includes(McpScopes.approvalsWrite)) {
    return undefined;
  }
  return {
    scopes: [McpScopes.approvalsWrite, ...authInfo.scopes],
    errorDescription: 'Voting needs your permission for this app to approve and reject as you',
  };
};

/** What the person is asked: the decision, and exactly what it would decide. */
function confirmationMessage(
  request: Awaited<ReturnType<ApprovalService['get']>>['request'],
  decision: VoteConfirmation['decision'],
  reason: string | null,
): string {
  return [
    `${decision === 'approve' ? 'Approve' : 'Reject'} this ${request.kind.replace('_', '-')} request as you?`,
    `Subject: ${request.subjectType} ${request.subjectId}`,
    `Change: ${JSON.stringify(request.action)}`,
    `Reason: ${reason ?? '(none)'}`,
    `Request: ${request.id}`,
  ].join('\n');
}

/**
 * Vote on an approval request as the caller, once they have confirmed it.
 *
 * The first call asks: it returns `input_required` with a confirmation naming the change,
 * and a signed state recording what was shown. The retry carries the person's answer;
 * only an accepted "yes" for the same vote reaches `ApprovalService.vote`.
 */
export async function voteOnApproval(
  deps: ApprovalToolDeps,
  args: VoteArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  const userId = userIdOf(ctx);
  // The HTTP layer has already challenged a token without the scope; this is the same
  // rule checked where the decision is made, in case anything ever routes around it.
  if (!(ctx.http?.authInfo?.scopes.includes(McpScopes.approvalsWrite) ?? false)) {
    return refused('This connection may not vote. Reconnect the app and allow it to approve and reject as you.');
  }
  const workspaceId = await deps.scope.resolve(userId, args.workspaceId);
  if (!(await deps.settings.agentsMayDecide(workspaceId))) {
    return refused(
      'Agents may not vote in this workspace. An owner or admin can allow it in Settings → Agents; until then, vote in the Mocco console.',
    );
  }
  const { confirmations } = deps;
  if (confirmations === undefined) {
    return refused('Voting through an agent is unavailable on this server: it cannot sign a confirmation.');
  }
  const asked: VoteConfirmation = {
    tool: VOTE_TOOL,
    workspaceId,
    requestId: args.requestId,
    decision: args.decision,
    reason: args.reason ?? null,
  };

  try {
    const echoed = ctx.mcpReq.requestState();
    if (echoed === undefined) {
      const { request } = await deps.approvals.get(workspaceId, args.requestId);
      if (request.state !== ApprovalStates.pending) {
        throw new ApprovalNotPendingError(request.id);
      }
      return inputRequired({
        inputRequests: {
          [CONFIRM]: inputRequired.elicit({
            message: confirmationMessage(request, args.decision, asked.reason),
            requestedSchema: confirmSchema,
          }),
        },
        requestState: await confirmations.mint(asked, ctx),
      });
    }

    // The state is signed and bound to this person; it must also be this vote, or a
    // confirmation of one decision could carry another.
    const shown = voteConfirmationSchema.safeParse(echoed);
    if (
      !shown.success ||
      shown.data.workspaceId !== asked.workspaceId ||
      shown.data.requestId !== asked.requestId ||
      shown.data.decision !== asked.decision ||
      shown.data.reason !== asked.reason
    ) {
      return refused('That confirmation was for a different vote. Call again without it to be asked afresh.');
    }
    // Declined, cancelled, missing, or an accepted "no" all read the same: no vote.
    if (acceptedContent(ctx.mcpReq.inputResponses, CONFIRM, confirmSchema)?.confirm !== true) {
      return asJson({ voted: false, reason: 'You did not confirm, so nothing was voted.' });
    }

    const { request, votes } = await deps.approvals.vote(
      workspaceId,
      args.requestId,
      userId,
      args.decision,
      args.reason,
    );
    return asJson({ voted: true, id: request.id, state: request.state, votes: votes.length });
  } catch (error) {
    return voteRefusal(error);
  }
}

export function registerApprovalTools(server: McpServer, deps: ApprovalToolDeps): void {
  server.registerTool(
    'mocco_approvals_search',
    {
      title: 'Find approval requests',
      description:
        'Find approval requests. The default — pending — is what is waiting on a human right now, which is usually the question being asked.',
      inputSchema: searchInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchApprovals(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_approvals_get',
    {
      title: 'Read one approval request',
      description:
        'One request: what change it pins, the requirements it has to satisfy, and the votes cast so far. Read-only — voting is mocco_approvals_vote.',
      inputSchema: readInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getApproval(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    VOTE_TOOL,
    {
      title: 'Vote on an approval request',
      description:
        'Approve or reject a pending request as the signed-in person. The person is asked to confirm in their client before the vote is cast. Only works where the workspace allows agents to decide, and only within the roles the request requires.',
      inputSchema: voteInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      scopeChallenge: requireApprovalsWrite,
    },
    async (args, ctx) => await voteOnApproval(deps, args, ctx),
  );
}
