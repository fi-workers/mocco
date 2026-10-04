// What every deciding tool checks before it asks anything, shared so the vote and the
// resume cannot drift apart: the `approvals:write` scope (challenged at the HTTP layer and
// checked again here), the workspace's opt-in, and a server able to sign a confirmation.
// None of them replaces the role check — the domain service still decides who may decide.
import { McpScopes } from '@mocco/common/mcp';
import { z } from 'zod';

import { userIdOf } from '@backend/transport/mcp/tools/runs';

import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import type { Confirmations } from '@backend/transport/mcp/confirmation';
import type { CallToolResult, ScopeChallengeHandler, ServerContext } from '@modelcontextprotocol/server';

export interface DecidingToolDeps {
  scope: WorkspaceScope;
  settings: Pick<McpSettingsService, 'agentsMayDecide'>;
  /** Signs the confirmation round trip. Absent without AUTH_SECRET, and then the deciding
   * tools refuse: a confirmation that cannot be verified is no confirmation. */
  confirmations: Confirmations | undefined;
}

/** A refusal the model reads and can act on. */
export const refused = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** The key the person's answer comes back under. */
export const CONFIRM = 'confirm';

/** The person's answer. A boolean field, because a form-mode elicitation can carry one
 * and every client renders it as the yes/no it is. */
export const confirmationSchema = (label: string) => z.object({ confirm: z.boolean().describe(label) });

/** A deciding tool needs `approvals:write`. A token without it is challenged for it
 * (HTTP 403, `insufficient_scope`) — every scope it already has plus this one, because
 * the client re-authorizes with exactly the set the challenge names. */
export function requireApprovalsWrite(errorDescription: string): ScopeChallengeHandler {
  // eslint-disable-next-line sonarjs/function-return-type -- the SDK's contract: a challenge, or undefined for none
  return ({ authInfo }) => {
    if (authInfo === undefined || authInfo.scopes.includes(McpScopes.approvalsWrite)) {
      return undefined;
    }
    return { scopes: [McpScopes.approvalsWrite, ...authInfo.scopes], errorDescription };
  };
}

/** How a tool names what it would do, in its refusals. */
export interface DecisionWords {
  /** "vote", "resume or reject runs". */
  verb: string;
  /** "Voting", "Resuming or rejecting a run". */
  doing: string;
}

export interface OpenDecision {
  userId: string;
  workspaceId: string;
  confirmations: Confirmations;
}

/**
 * The checks every deciding tool makes before it asks the person anything. Returns who is
 * deciding, where, and the codec to confirm with — or the refusal to answer with.
 */
export async function openDecision(
  deps: DecidingToolDeps,
  ctx: ServerContext,
  workspaceArgument: string | undefined,
  words: DecisionWords,
): Promise<OpenDecision | CallToolResult> {
  const userId = userIdOf(ctx);
  // The HTTP layer has already challenged a token without the scope; this is the same
  // rule checked where the decision is made, in case anything ever routes around it.
  if (!(ctx.http?.authInfo?.scopes.includes(McpScopes.approvalsWrite) ?? false)) {
    return refused(
      `This connection may not ${words.verb}. Reconnect the app and allow it to approve and reject as you.`,
    );
  }
  const workspaceId = await deps.scope.resolve(userId, workspaceArgument);
  if (!(await deps.settings.agentsMayDecide(workspaceId))) {
    return refused(
      `Agents may not ${words.verb} in this workspace. An owner or admin can allow it in Settings → Agents; until then, ${words.verb} in the Mocco console.`,
    );
  }
  const { confirmations } = deps;
  if (confirmations === undefined) {
    return refused(`${words.doing} through an agent is unavailable on this server: it cannot sign a confirmation.`);
  }
  return { userId, workspaceId, confirmations };
}
