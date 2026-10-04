// Status router (#148): a project's status pages and their components. Every procedure
// requires the status product to be enabled and the project to belong to the workspace
// (`productProcedure`), which also maps the domain's error families
// (StatusEntityNotFoundError → NOT_FOUND, StatusPageSlugTakenError → CONFLICT). Entities are
// looked up within the caller's workspace and project, so another tenant's id is NOT_FOUND.
import { Products } from '@mocco/common/project';
import {
  componentGroupInputSchema,
  componentInputSchema,
  componentStatusSchema,
  statusPageInputSchema,
} from '@mocco/common/status';
import { z } from 'zod';

import { productProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const projectInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });
const pageInput = projectInput.extend({ pageId: z.uuid() });
const groupInput = projectInput.extend({ groupId: z.uuid() });
const componentInput = projectInput.extend({ componentId: z.uuid() });
const protectedStatusProcedure = productProcedure(Products.status);

const scopeOf = (input: { workspaceId: string; projectId: string }) => ({
  workspaceId: input.workspaceId,
  projectId: input.projectId,
});

export const statusRouter = router({
  pages: protectedStatusProcedure.input(projectInput).query(async ({ ctx, input }) => ({
    pages: await ctx.statusPages.listPages(scopeOf(input)),
  })),

  /** The page with its groups and components, in order. */
  page: protectedStatusProcedure
    .input(pageInput)
    .query(async ({ ctx, input }) => await ctx.statusPages.getPage(scopeOf(input), input.pageId)),

  createPage: protectedStatusProcedure
    .input(projectInput.and(statusPageInputSchema))
    .mutation(async ({ ctx, input }) => ({
      page: await ctx.statusPages.createPage(scopeOf(input), ctx.session.user.id, {
        slug: input.slug,
        title: input.title,
      }),
    })),

  updatePage: protectedStatusProcedure.input(pageInput.and(statusPageInputSchema)).mutation(async ({ ctx, input }) => ({
    page: await ctx.statusPages.updatePage(scopeOf(input), input.pageId, { slug: input.slug, title: input.title }),
  })),

  deletePage: protectedStatusProcedure.input(pageInput).mutation(async ({ ctx, input }) => {
    await ctx.statusPages.deletePage(scopeOf(input), ctx.session.user.id, input.pageId);
    return { ok: true } as const;
  }),

  createGroup: protectedStatusProcedure
    .input(pageInput.and(componentGroupInputSchema))
    .mutation(async ({ ctx, input }) => ({
      group: await ctx.statusPages.createGroup(scopeOf(input), input.pageId, input),
    })),

  updateGroup: protectedStatusProcedure
    .input(groupInput.and(componentGroupInputSchema))
    .mutation(async ({ ctx, input }) => ({
      group: await ctx.statusPages.updateGroup(scopeOf(input), input.groupId, {
        name: input.name,
        ...(input.position !== undefined && { position: input.position }),
      }),
    })),

  deleteGroup: protectedStatusProcedure.input(groupInput).mutation(async ({ ctx, input }) => {
    await ctx.statusPages.deleteGroup(scopeOf(input), input.groupId);
    return { ok: true } as const;
  }),

  createComponent: protectedStatusProcedure
    .input(pageInput.and(componentInputSchema))
    .mutation(async ({ ctx, input }) => ({
      component: await ctx.statusPages.createComponent(scopeOf(input), input.pageId, input),
    })),

  updateComponent: protectedStatusProcedure
    .input(componentInput.and(componentInputSchema))
    .mutation(async ({ ctx, input }) => ({
      component: await ctx.statusPages.updateComponent(scopeOf(input), input.componentId, input),
    })),

  /** Set the status an operator reports by hand (audited). */
  setComponentStatus: protectedStatusProcedure
    .input(componentInput.extend({ status: componentStatusSchema }))
    .mutation(async ({ ctx, input }) => ({
      component: await ctx.statusPages.setComponentStatus(
        scopeOf(input),
        ctx.session.user.id,
        input.componentId,
        input.status,
      ),
    })),

  deleteComponent: protectedStatusProcedure.input(componentInput).mutation(async ({ ctx, input }) => {
    await ctx.statusPages.deleteComponent(scopeOf(input), input.componentId);
    return { ok: true } as const;
  }),
});
