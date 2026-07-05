import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { router, publicProcedure, protectedProcedure } from './trpc';

// Parse, don't validate: slug is constrained here AND case-insensitively unique at the DB.
const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes only');

// Egress filter: .output() schemas strip vendor-side fields (e.g. metadata) and
// normalize shapes before anything crosses the wire — the auth service returns
// vendor-compatible rows untouched (runtime-probed: raw rows DO carry metadata).
const workspaceOutput = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  // Vendor emits `string | null | undefined`; the wire shape is `string | null`.
  logo: z
    .string()
    .nullish()
    .transform(value => value ?? null),
  createdAt: z.date(),
});

const memberOutput = z.object({
  id: z.string(),
  userId: z.string(),
  role: z.string(),
  createdAt: z.date(),
});

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),

  workspace: router({
    list: protectedProcedure
      .output(z.array(workspaceOutput))
      .query(async ({ ctx }) => await ctx.auth.listWorkspaces(ctx.headers)),

    active: protectedProcedure
      .output(workspaceOutput.extend({ members: z.array(memberOutput) }).nullable())
      .query(async ({ ctx }) => await ctx.auth.getActiveWorkspace(ctx.headers)),

    create: protectedProcedure
      .input(z.object({ name: z.string().min(1).max(80), slug: slugSchema }))
      .output(workspaceOutput)
      .mutation(async ({ ctx, input }) => {
        try {
          return await ctx.auth.createWorkspace(ctx.headers, input);
        } catch (error) {
          // Map ONLY duplicate-slug rejections; anything else re-throws untouched.
          // Two sources: the vendor's exact-match pre-check (BAD_REQUEST "already
          // exists"), and the DB's case-insensitive lower(slug) unique index
          // (concurrent / case-variant races surface as a pg unique violation).
          const { status } = error as { status?: string };
          const { message } = error as Error;
          const causeText = (error as { cause?: { message?: string } }).cause?.message;
          if (
            (status === 'BAD_REQUEST' && /already exists/i.test(message)) ||
            (causeText?.includes('mocco_workspaces_slug_lower_uq') ?? false)
          ) {
            throw new TRPCError({ code: 'CONFLICT', message: 'That slug is already taken.' });
          }
          throw error;
        }
      }),

    setActive: protectedProcedure.input(z.object({ workspaceId: z.uuid() })).mutation(async ({ ctx, input }) => {
      await ctx.auth.setActiveWorkspace(ctx.headers, input.workspaceId);
      return { ok: true } as const;
    }),
  }),
});

export type AppRouter = typeof appRouter;
