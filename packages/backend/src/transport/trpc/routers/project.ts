// Project router (ADR 0013) — thin: parse at the boundary (zod DTOs from
// @mocco/common/project), delegate to ProjectService, and rely on the shared project
// procedures for tenant checks and error mapping.
import {
  projectAppCreateInputSchema,
  projectAppSchema,
  projectCreateInputSchema,
  projectRepoSchema,
  projectSchema,
} from '@mocco/common/project';
import { z } from 'zod';

import { protectedProjectProcedure, protectedWorkspaceProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const workspaceInput = z.object({ workspaceId: z.uuid() });
const projectInput = workspaceInput.extend({ projectId: z.uuid() });

export const projectRouter = router({
  create: protectedWorkspaceProcedure
    .input(workspaceInput.extend(projectCreateInputSchema.shape))
    .output(z.object({ project: projectSchema }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, ...values } = input;
      return { project: await ctx.projects.create(workspaceId, values) };
    }),

  list: protectedWorkspaceProcedure
    .input(workspaceInput.extend({ includeArchived: z.boolean().default(false) }))
    .output(z.object({ projects: z.array(projectSchema) }))
    .query(async ({ ctx, input }) => ({
      projects: await ctx.projects.list(input.workspaceId, { includeArchived: input.includeArchived }),
    })),

  get: protectedProjectProcedure
    .input(projectInput)
    .output(z.object({ project: projectSchema }))
    .query(async ({ ctx, input }) => ({
      project: await ctx.projects.requireProject(input.workspaceId, input.projectId),
    })),

  update: protectedProjectProcedure
    .input(projectInput.extend(projectCreateInputSchema.partial().shape))
    .output(z.object({ project: projectSchema }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...values } = input;
      return { project: await ctx.projects.update(workspaceId, projectId, values) };
    }),

  setArchived: protectedProjectProcedure
    .input(projectInput.extend({ archived: z.boolean() }))
    .output(z.object({ project: projectSchema }))
    .mutation(async ({ ctx, input }) => ({
      project: await ctx.projects.setArchived(input.workspaceId, input.projectId, input.archived),
    })),

  addApp: protectedProjectProcedure
    .input(projectInput.extend(projectAppCreateInputSchema.shape))
    .output(z.object({ app: projectAppSchema }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...values } = input;
      return { app: await ctx.projects.addApp(workspaceId, projectId, values) };
    }),

  listApps: protectedProjectProcedure
    .input(projectInput)
    .output(z.object({ apps: z.array(projectAppSchema) }))
    .query(async ({ ctx, input }) => ({ apps: await ctx.projects.listApps(input.workspaceId, input.projectId) })),

  removeApp: protectedProjectProcedure
    .input(projectInput.extend({ appId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.projects.removeApp(input.workspaceId, input.projectId, input.appId);
      return { ok: true } as const;
    }),

  linkRepo: protectedProjectProcedure
    .input(projectInput.extend({ repoId: z.uuid() }))
    .output(z.object({ link: projectRepoSchema }))
    .mutation(async ({ ctx, input }) => ({
      link: await ctx.projects.linkRepo(input.workspaceId, input.projectId, input.repoId),
    })),

  unlinkRepo: protectedProjectProcedure
    .input(projectInput.extend({ repoId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.projects.unlinkRepo(input.workspaceId, input.projectId, input.repoId);
      return { ok: true } as const;
    }),

  listRepos: protectedProjectProcedure
    .input(projectInput)
    .output(z.object({ links: z.array(projectRepoSchema) }))
    .query(async ({ ctx, input }) => ({ links: await ctx.projects.listRepos(input.workspaceId, input.projectId) })),
});
