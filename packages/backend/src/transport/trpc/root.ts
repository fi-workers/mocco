// The single composition point: domain routers merge here (composition, not a
// barrel — nothing is re-exported, a new router value is built).
import { debugRouter } from './routers/debug';
import { pipelineRouter } from './routers/pipeline';
import { workspaceRouter } from './routers/workspace';
import { publicProcedure, router } from './trpc';

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),

  workspace: workspaceRouter,
  pipeline: pipelineRouter,
  debug: debugRouter,
});

export type AppRouter = typeof appRouter;
