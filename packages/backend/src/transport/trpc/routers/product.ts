// Product-enablement router (ADR 0013) — which product lines a workspace has turned
// on. Thin: delegates to ProductEnablementService; tenant checks and error mapping
// come from the shared workspace procedure.
import { productSchema } from '@mocco/common/project';
import { z } from 'zod';

import { protectedWorkspaceProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const productInput = z.object({ workspaceId: z.uuid(), product: productSchema });

export const productRouter = router({
  list: protectedWorkspaceProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .output(z.object({ products: z.array(productSchema) }))
    .query(async ({ ctx, input }) => ({ products: await ctx.products.list(input.workspaceId) })),

  enable: protectedWorkspaceProcedure.input(productInput).mutation(async ({ ctx, input }) => {
    await ctx.products.enable(input.workspaceId, input.product, ctx.session.user.id);
    return { ok: true } as const;
  }),

  disable: protectedWorkspaceProcedure.input(productInput).mutation(async ({ ctx, input }) => {
    await ctx.products.disable(input.workspaceId, input.product);
    return { ok: true } as const;
  }),
});
