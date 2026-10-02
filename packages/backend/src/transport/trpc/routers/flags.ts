// Flags router — thin: environments, flag definitions and immediate changesets of a
// project (#137). Every procedure requires the flags product to be enabled and the
// project to belong to the workspace (`productProcedure`), which also maps the project
// domain's error family; flag errors extend the same bases.
import {
  booleanFlagCreateInputSchema,
  changeOpSchema,
  changesetSchema,
  flagConfigSchema,
  flagEnvironmentCreateInputSchema,
  flagCreateInputSchema,
  flagEnvironmentSchema,
  flagSchema,
  flagSegmentSchema,
} from '@mocco/common/flags';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { productProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const projectInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });
const environmentInput = projectInput.extend({ environmentId: z.uuid() });
const flagsProcedure = productProcedure(Products.flags);

export const flagsRouter = router({
  environments: flagsProcedure
    .input(projectInput)
    .output(z.object({ environments: z.array(flagEnvironmentSchema) }))
    .query(async ({ ctx, input }) => ({
      environments: await ctx.flags.listEnvironments(input.workspaceId, input.projectId),
    })),

  createEnvironment: flagsProcedure
    .input(projectInput.extend(flagEnvironmentCreateInputSchema.shape))
    .output(z.object({ environment: flagEnvironmentSchema }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...values } = input;
      return { environment: await ctx.flags.createEnvironment(workspaceId, projectId, ctx.session.user.id, values) };
    }),

  list: flagsProcedure
    .input(projectInput)
    .output(z.object({ flags: z.array(flagSchema.extend({ configs: z.array(flagConfigSchema) })) }))
    .query(async ({ ctx, input }) => ({ flags: await ctx.flags.listFlags(input.workspaceId, input.projectId) })),

  createBoolean: flagsProcedure
    .input(projectInput.extend(booleanFlagCreateInputSchema.shape))
    .output(z.object({ flag: flagSchema }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...values } = input;
      return { flag: await ctx.flags.createBooleanFlag(workspaceId, projectId, ctx.session.user.id, values) };
    }),

  create: flagsProcedure
    .input(z.object({ workspaceId: z.uuid(), projectId: z.uuid(), flag: flagCreateInputSchema }))
    .output(z.object({ flag: flagSchema }))
    .mutation(async ({ ctx, input }) => ({
      flag: await ctx.flags.createFlag(input.workspaceId, input.projectId, ctx.session.user.id, input.flag),
    })),

  segments: flagsProcedure
    .input(environmentInput)
    .output(z.object({ segments: z.array(flagSegmentSchema) }))
    .query(async ({ ctx, input }) => ({
      segments: await ctx.flags.listSegments(input.workspaceId, input.projectId, input.environmentId),
    })),

  /** Evaluate every flag of the environment for a context, optionally with unsaved ops applied. */
  preview: flagsProcedure
    .input(
      environmentInput.extend({
        ops: z.array(changeOpSchema).max(100).default([]),
        context: z.record(z.string(), z.unknown()),
      }),
    )
    .output(
      z.object({
        results: z.array(
          z.object({
            flagKey: z.string(),
            value: z.unknown(),
            variant: z.string().nullable(),
            reason: z.string(),
            errorCode: z.string().nullable(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...preview } = input;
      return { results: await ctx.flags.preview(workspaceId, projectId, preview) };
    }),

  applyChangeset: flagsProcedure
    .input(
      environmentInput.extend({
        baseVersion: z.number().int().min(0),
        ops: z.array(changeOpSchema).min(1).max(100),
        reason: z.string().max(500).nullable().default(null),
      }),
    )
    .output(z.object({ changeset: changesetSchema }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...change } = input;
      return { changeset: await ctx.flags.applyChangeset(workspaceId, projectId, ctx.session.user.id, change) };
    }),

  history: flagsProcedure
    .input(environmentInput)
    .output(z.object({ changesets: z.array(changesetSchema) }))
    .query(async ({ ctx, input }) => ({
      changesets: await ctx.flags.history(input.workspaceId, input.projectId, input.environmentId),
    })),

  ruleset: flagsProcedure
    .input(environmentInput)
    .output(z.object({ version: z.number(), etag: z.string(), document: z.record(z.string(), z.unknown()) }))
    .query(async ({ ctx, input }) => {
      const snapshot = await ctx.flags.ruleset(input.workspaceId, input.projectId, input.environmentId);
      return { version: snapshot.version, etag: snapshot.etag, document: snapshot.document };
    }),
});
