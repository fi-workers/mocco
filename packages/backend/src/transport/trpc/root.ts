// The single composition point: domain routers merge here (composition, not a
// barrel — nothing is re-exported, a new router value is built).
import { approvalRouter } from '@backend/transport/trpc/routers/approval';
import { auditRouter } from '@backend/transport/trpc/routers/audit';
import { credentialGrantRouter } from '@backend/transport/trpc/routers/credentialGrant';
import { inboundRouter } from '@backend/transport/trpc/routers/inbound';
import { integrationRouter } from '@backend/transport/trpc/routers/integration';
import { notificationRouter } from '@backend/transport/trpc/routers/notification';
import { otaRouter } from '@backend/transport/trpc/routers/ota';
import { pipelineRouter } from '@backend/transport/trpc/routers/pipeline';
import { productRouter } from '@backend/transport/trpc/routers/product';
import { projectRouter } from '@backend/transport/trpc/routers/project';
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
  approval: approvalRouter,
  project: projectRouter,
  product: productRouter,
  ota: otaRouter,
  inbound: inboundRouter,
  notification: notificationRouter,
});

export type AppRouter = typeof appRouter;
