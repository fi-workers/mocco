// MCP settings router (ADR 0025) — thin: any member reads what the workspace allows
// agents; owners and admins change it, because turning the deciding tools on lets an
// agent cast a vote that can release a production deploy.
import { mcpSetAgentsMayDecideInputSchema, mcpSettingsSchema } from '@mocco/common/mcp';
import { z } from 'zod';

import { protectedWorkspaceProcedure, rethrowProjectDomainError } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const workspaceInput = z.object({ workspaceId: z.uuid() });

/** Owners and admins of the workspace; a plain member gets FORBIDDEN. */
const adminWorkspaceProcedure = protectedWorkspaceProcedure.use(async ({ ctx, getRawInput, next }) => {
  const { workspaceId } = workspaceInput.parse(await getRawInput());
  try {
    await ctx.workspace.assertAdmin(ctx.headers, workspaceId);
  } catch (error) {
    rethrowProjectDomainError(error);
    throw error;
  }
  return await next();
});

export const mcpRouter = router({
  settings: protectedWorkspaceProcedure
    .input(workspaceInput)
    .output(z.object({ settings: mcpSettingsSchema }))
    .query(async ({ ctx, input }) => ({ settings: await ctx.mcpSettings.get(input.workspaceId) })),

  setAgentsMayDecide: adminWorkspaceProcedure
    .input(mcpSetAgentsMayDecideInputSchema)
    .output(z.object({ settings: mcpSettingsSchema }))
    .mutation(async ({ ctx, input }) => ({
      settings: await ctx.mcpSettings.setAgentsMayDecide(input.workspaceId, input.agentsMayDecide, ctx.session.user.id),
    })),
});
