// The single composition point: domain routers merge here (composition, not a
// barrel — nothing is re-exported, a new router value is built).
import { auditRouter } from '@backend/transport/trpc/routers/audit';
import { credentialGrantRouter } from '@backend/transport/trpc/routers/credentialGrant';
import { integrationRouter } from '@backend/transport/trpc/routers/integration';
import { pipelineRouter } from '@backend/transport/trpc/routers/pipeline';
import { roleRouter } from '@backend/transport/trpc/routers/role';
import { runRouter } from '@backend/transport/trpc/routers/run';
import { workspaceRouter } from '@backend/transport/trpc/routers/workspace';
import { publicProcedure, router } from '@backend/transport/trpc/trpc';

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),

  workspace: workspaceRouter,
  integration: integrationRouter,
  pipeline: pipelineRouter,
  run: runRouter,
  role: roleRouter,
  credentialGrant: credentialGrantRouter,
  audit: auditRouter,
});

export type AppRouter = typeof appRouter;
