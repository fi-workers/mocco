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
