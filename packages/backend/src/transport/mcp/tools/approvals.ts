// `mocco_approvals_*` — what is waiting on a human, and on whom.
//
// Read-only. Voting is a decision, and a decision needs the confirmation round trip and
// the opt-in that slice 6 brings; nothing here can resolve a request.
//
// These tools exist on MCP and not on `/v1` for a structural reason, not an arbitrary
// one: an approval request is workspace-scoped with an opaque subject, so it cannot be
// narrowed to the project an API key speaks for. A person in a workspace is exactly the
// right unit of scope, and that is who is calling here.
import { ApprovalStates } from '@mocco/common/governance';
import { z } from 'zod';

import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import type { McpServer } from '@modelcontextprotocol/server';

export interface ApprovalToolDeps {
  approvals: Pick<ApprovalService, 'list' | 'get'>;
  scope: WorkspaceScope;
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
        'One request: what change it pins, the requirements it has to satisfy, and the votes cast so far. Read-only — approving is a separate, opt-in tool.',
      inputSchema: readInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getApproval(deps, args, userIdOf(ctx))),
  );
}
