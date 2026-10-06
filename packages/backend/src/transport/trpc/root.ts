// The single composition point: domain routers merge here (composition, not a
// barrel — nothing is re-exported, a new router value is built).
import { apiKeyRouter } from '@backend/transport/trpc/routers/apiKey';
import { approvalRouter } from '@backend/transport/trpc/routers/approval';
import { auditRouter } from '@backend/transport/trpc/routers/audit';
import { credentialGrantRouter } from '@backend/transport/trpc/routers/credentialGrant';
import { feedbackRouter } from '@backend/transport/trpc/routers/feedback';
import { flagsRouter } from '@backend/transport/trpc/routers/flags';
import { helpRouter } from '@backend/transport/trpc/routers/help';
import { inboundRouter } from '@backend/transport/trpc/routers/inbound';
import { integrationRouter } from '@backend/transport/trpc/routers/integration';
import { mcpRouter } from '@backend/transport/trpc/routers/mcp';
import { messengerRouter } from '@backend/transport/trpc/routers/messenger';
import { notificationRouter } from '@backend/transport/trpc/routers/notification';
import { otaRouter } from '@backend/transport/trpc/routers/ota';
import { pipelineRouter } from '@backend/transport/trpc/routers/pipeline';
import { productRouter } from '@backend/transport/trpc/routers/product';
import { projectRouter } from '@backend/transport/trpc/routers/project';
import { roleRouter } from '@backend/transport/trpc/routers/role';
import { runRouter } from '@backend/transport/trpc/routers/run';
import { statusRouter } from '@backend/transport/trpc/routers/status';
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
  flags: flagsRouter,
  messenger: messengerRouter,
  help: helpRouter,
  feedback: feedbackRouter,
  status: statusRouter,
  apiKey: apiKeyRouter,
  mcp: mcpRouter,
  inbound: inboundRouter,
  notification: notificationRouter,
});

export type AppRouter = typeof appRouter;
