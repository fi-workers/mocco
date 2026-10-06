import { z } from 'zod';

/**
 * A workspace's MCP settings. `agentsMayDecide` is the opt-in for the deciding tools
 * (`mocco_approvals_vote`, `mocco_gates_resume`): off unless an owner or admin turns it on,
 * because those tools can release a production deploy. It widens nothing by itself — every
 * tool still acts as its caller, under that person's roles.
 */
export const mcpSettingsSchema = z.object({
  agentsMayDecide: z.boolean(),
  /** When it was last switched, and by whom; both null while it has never been touched. */
  changedAt: z.date().nullable(),
  changedByUserId: z.string().nullable(),
});
export type McpSettings = z.infer<typeof mcpSettingsSchema>;

export const mcpSetAgentsMayDecideInputSchema = z.object({
  workspaceId: z.uuid(),
  agentsMayDecide: z.boolean(),
});

/**
 * The OAuth scopes the MCP authorization server grants beyond sign-in.
 *
 * `approvals:write` lets an agent vote as its person. It is not asked for when a client
 * first connects: the client is challenged for it (step-up) the first time it calls a
 * deciding tool, so the person grants it at the moment a decision is actually wanted.
 * `status:write` lets an agent run a monitor's ad-hoc check as its person, stepped up for
 * the same way the first time a tool needs it. `messenger:write` lets an agent reply to a
 * conversation and assign it as its person, stepped up for the same way. `feedback:write` lets
 * an agent move a feedback post to another status as its person, stepped up for the same way.
 * The keys are camel-cased because the values follow OAuth's `resource:action` form.
 */
export const McpScopes = {
  approvalsWrite: 'approvals:write',
  statusWrite: 'status:write',
  messengerWrite: 'messenger:write',
  feedbackWrite: 'feedback:write',
} as const;
export type McpScope = (typeof McpScopes)[keyof typeof McpScopes];

/** What a client is asked for when it first connects: who the person is, and staying
 * signed in. Reading needs nothing more. */
export const mcpSignInScopes = ['openid', 'profile', 'email', 'offline_access'] as const;
