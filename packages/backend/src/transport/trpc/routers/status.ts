// Status router (#148): a project's status pages, components, incidents and maintenance.
// Every procedure requires the status product to be enabled and the project to belong to
// the workspace (`productProcedure`), which also maps the domain's error families
// (StatusEntityNotFoundError → NOT_FOUND, IncidentTransitionError and the other conflicts →
// CONFLICT, MaintenanceWindowError → BAD_REQUEST). Entities are looked up within the
// caller's workspace and project, so another tenant's id is NOT_FOUND.
import { Products } from '@mocco/common/project';
import {
  affectedComponentsSchema,
  componentGroupInputSchema,
  componentInputSchema,
  componentStatusSchema,
  incidentCreateInputSchema,
  incidentUpdateInputSchema,
  maintenanceInputSchema,
  postmortemInputSchema,
  statusPageInputSchema,
} from '@mocco/common/status';
import { z } from 'zod';

import { productProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const projectInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });
const pageInput = projectInput.extend({ pageId: z.uuid() });
const groupInput = projectInput.extend({ groupId: z.uuid() });
const componentInput = projectInput.extend({ componentId: z.uuid() });
const incidentInput = projectInput.extend({ incidentId: z.uuid() });
const maintenanceInput = projectInput.extend({ maintenanceId: z.uuid() });
const protectedStatusProcedure = productProcedure(Products.status);

const scopeOf = (input: { workspaceId: string; projectId: string }) => ({
  workspaceId: input.workspaceId,
  projectId: input.projectId,
});

export const statusRouter = router({
  pages: protectedStatusProcedure.input(projectInput).query(async ({ ctx, input }) => ({
    pages: await ctx.statusPages.listPages(scopeOf(input)),
  })),

  /** The page with its groups and components; each component carries the status it shows. */
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

  incidents: protectedStatusProcedure
    .input(pageInput.extend({ openOnly: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => ({
      incidents: await ctx.statusIncidents.list(scopeOf(input), input.pageId, input.openOnly),
    })),

  /** The incident with its timeline and affected components. */
  incident: protectedStatusProcedure
    .input(incidentInput)
    .query(async ({ ctx, input }) => await ctx.statusIncidents.get(scopeOf(input), input.incidentId)),

  createIncident: protectedStatusProcedure
    .input(projectInput.and(incidentCreateInputSchema))
    .mutation(async ({ ctx, input }) => ({
      incident: await ctx.statusIncidents.create(scopeOf(input), ctx.session.user.id, input),
    })),

  /** Post a timeline update; an illegal status change is CONFLICT. */
  postIncidentUpdate: protectedStatusProcedure.input(incidentInput.and(incidentUpdateInputSchema)).mutation(
    async ({ ctx, input }) =>
      await ctx.statusIncidents.postUpdate(scopeOf(input), ctx.session.user.id, input.incidentId, {
        status: input.status,
        body: input.body,
      }),
  ),

  setIncidentComponents: protectedStatusProcedure
    .input(incidentInput.extend({ components: affectedComponentsSchema }))
    .mutation(async ({ ctx, input }) => {
      await ctx.statusIncidents.setComponents(scopeOf(input), ctx.session.user.id, input.incidentId, input.components);
      return { ok: true } as const;
    }),

  setPostmortem: protectedStatusProcedure
    .input(incidentInput.and(postmortemInputSchema))
    .mutation(async ({ ctx, input }) => ({
      incident: await ctx.statusIncidents.setPostmortem(
        scopeOf(input),
        ctx.session.user.id,
        input.incidentId,
        input.postmortem,
      ),
    })),

  maintenances: protectedStatusProcedure.input(pageInput).query(async ({ ctx, input }) => ({
    maintenances: await ctx.statusMaintenances.list(scopeOf(input), input.pageId),
  })),

  scheduleMaintenance: protectedStatusProcedure
    .input(projectInput.and(maintenanceInputSchema))
    .mutation(async ({ ctx, input }) => ({
      maintenance: await ctx.statusMaintenances.schedule(scopeOf(input), ctx.session.user.id, input),
    })),

  cancelMaintenance: protectedStatusProcedure.input(maintenanceInput).mutation(async ({ ctx, input }) => ({
    maintenance: await ctx.statusMaintenances.cancel(scopeOf(input), ctx.session.user.id, input.maintenanceId),
  })),
});
