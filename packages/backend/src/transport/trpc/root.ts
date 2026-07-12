// The single composition point: domain routers merge here (composition, not a
// barrel — nothing is re-exported, a new router value is built).
import { pipelineRouter } from './routers/pipeline';
import { workspaceRouter } from './routers/workspace';
import { publicProcedure, router } from './trpc';

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),

  workspace: workspaceRouter,
  pipeline: pipelineRouter,
});

export type AppRouter = typeof appRouter;
