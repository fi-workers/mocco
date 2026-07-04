import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { createWorkspace, getActiveWorkspace, listWorkspaces, setActiveWorkspace } from '../auth';

import { router, publicProcedure, protectedProcedure } from './trpc';

// Parse, don't validate: slug is constrained here AND case-insensitively unique at the DB.
const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes only');

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),

  workspace: router({
    list: protectedProcedure.query(async ({ ctx }) => await listWorkspaces(ctx.headers)),

    active: protectedProcedure.query(async ({ ctx }) => await getActiveWorkspace(ctx.headers)),

    create: protectedProcedure
      .input(z.object({ name: z.string().min(1).max(80), slug: slugSchema }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await createWorkspace(ctx.headers, input);
        } catch (error) {
          const { status } = error as { status?: string };
          if (status === 'BAD_REQUEST') {
            throw new TRPCError({ code: 'CONFLICT', message: 'That slug is already taken.' });
          }
          throw error;
        }
      }),

    setActive: protectedProcedure.input(z.object({ workspaceId: z.uuid() })).mutation(async ({ ctx, input }) => {
      await setActiveWorkspace(ctx.headers, input.workspaceId);
      return { ok: true } as const;
    }),
  }),
});

export type AppRouter = typeof appRouter;
