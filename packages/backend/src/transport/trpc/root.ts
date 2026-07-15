// The single composition point: domain routers merge here (composition, not a
// barrel — nothing is re-exported, a new router value is built).
import { debugRouter } from '@backend/transport/trpc/routers/debug';
import { pipelineRouter } from '@backend/transport/trpc/routers/pipeline';
import { workspaceRouter } from '@backend/transport/trpc/routers/workspace';
import { publicProcedure, router } from '@backend/transport/trpc/trpc';

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),

  workspace: workspaceRouter,
  pipeline: pipelineRouter,
  debug: debugRouter,
});

export type AppRouter = typeof appRouter;
