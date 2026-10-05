// Status router (#148, #150): a project's status pages, components, incidents, maintenance
// and monitors. Every project procedure requires the status product to be enabled and the
// project to belong to the workspace (`productProcedure`), which also maps the domain's error
// families (StatusEntityNotFoundError → NOT_FOUND, IncidentTransitionError and the other
// conflicts → CONFLICT, MaintenanceWindowError → BAD_REQUEST). Entities are looked up within
// the caller's workspace and project, so another tenant's id is NOT_FOUND. Probe locations
// belong to the workspace: listing them needs membership, and creating, rotating or disabling
// one (which issues or revokes a token) needs an owner or admin. The runs linked to incidents
// (#154) are read and changed here on both sides, including a run's own incidents, so the
// execution domain never depends on status.
import { Products } from '@mocco/common/project';
import {
  affectedComponentsSchema,
  componentGroupInputSchema,
  componentInputSchema,
  componentStatusSchema,
  incidentCreateInputSchema,
  incidentRunSchema,
  incidentUpdateInputSchema,
  locationInputSchema,
  locationSchema,
  maintenanceInputSchema,
  manualIncidentRunRelationSchema,
  monitorInputSchema,
  postmortemInputSchema,
  runIncidentSchema,
  statusPageInputSchema,
} from '@mocco/common/status';
import { z } from 'zod';

import {
  productProcedure,
  protectedWorkspaceProcedure,
  rethrowProjectDomainError,
} from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const projectInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });
const pageInput = projectInput.extend({ pageId: z.uuid() });
const groupInput = projectInput.extend({ groupId: z.uuid() });
const componentInput = projectInput.extend({ componentId: z.uuid() });
const incidentInput = projectInput.extend({ incidentId: z.uuid() });
const incidentRunInput = incidentInput.extend({ runId: z.uuid() });
const maintenanceInput = projectInput.extend({ maintenanceId: z.uuid() });
const monitorInput = projectInput.extend({ monitorId: z.uuid() });
const workspaceInput = z.object({ workspaceId: z.uuid() });
const locationInput = workspaceInput.extend({ locationId: z.uuid() });
const protectedStatusProcedure = productProcedure(Products.status);

/** Run a pre-next() check, surfacing its domain error as the mapped tRPC error. */
const check = async (run: () => Promise<void>): Promise<void> => {
  try {
    await run();
  } catch (error) {
    rethrowProjectDomainError(error);
    throw error;
  }
};

/** A workspace-level status procedure: membership (NOT_FOUND otherwise) and the status product
 * enabled (FORBIDDEN otherwise). */
const statusWorkspaceProcedure = protectedWorkspaceProcedure.use(async ({ ctx, getRawInput, next }) => {
  const { workspaceId } = workspaceInput.parse(await getRawInput());
  await check(async () => {
    await ctx.products.assertEnabled(workspaceId, Products.status);
  });
  return await next();
});

/** Also requires an owner or admin (FORBIDDEN for a plain member): location tokens are credentials. */
const adminStatusWorkspaceProcedure = statusWorkspaceProcedure.use(async ({ ctx, getRawInput, next }) => {
  const { workspaceId } = workspaceInput.parse(await getRawInput());
  await check(async () => {
    await ctx.workspace.assertAdmin(ctx.headers, workspaceId);
  });
  return await next();
});

const locationWithToken = z.object({ location: locationSchema, token: z.string() });

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

  /** The runs linked to the incident: Mocco's suggestions, best first, and a person's links. */
  incidentRuns: protectedStatusProcedure
    .input(incidentInput)
    .output(z.object({ runs: z.array(incidentRunSchema) }))
    .query(async ({ ctx, input }) => ({
      runs: await ctx.statusCorrelation.list(scopeOf(input), input.incidentId),
    })),

  /** Recompute the suggested runs (releases around the incident's start); a person's links stay. */
  correlateIncident: protectedStatusProcedure
    .input(incidentInput)
    .output(z.object({ suggested: z.int() }))
    .mutation(async ({ ctx, input }) => await ctx.statusCorrelation.correlate(scopeOf(input), input.incidentId)),

  /** Link a run of the workspace to the incident (audited). */
  linkRun: protectedStatusProcedure
    .input(incidentRunInput.extend({ relation: manualIncidentRunRelationSchema }))
    .output(z.object({ link: incidentRunSchema.omit({ run: true }) }))
    .mutation(async ({ ctx, input }) => ({
      link: await ctx.statusCorrelation.link(scopeOf(input), ctx.session.user.id, {
        incidentId: input.incidentId,
        runId: input.runId,
        relation: input.relation,
      }),
    })),

  /** Remove a run's link, suggested or not (audited). */
  unlinkRun: protectedStatusProcedure.input(incidentRunInput).mutation(async ({ ctx, input }) => {
    await ctx.statusCorrelation.unlink(scopeOf(input), ctx.session.user.id, {
      incidentId: input.incidentId,
      runId: input.runId,
    });
    return { ok: true } as const;
  }),

  /** The incidents a run is linked to, for the run's page: workspace-scoped, like runs. */
  runIncidents: statusWorkspaceProcedure
    .input(workspaceInput.extend({ runId: z.uuid() }))
    .output(z.object({ incidents: z.array(runIncidentSchema) }))
    .query(async ({ ctx, input }) => ({
      incidents: await ctx.statusCorrelation.incidentsForRun(input.workspaceId, input.runId),
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

  /** The project's monitors, each with its location ids and components. */
  monitors: protectedStatusProcedure.input(projectInput).query(async ({ ctx, input }) => ({
    monitors: await ctx.statusMonitors.list(scopeOf(input)),
  })),

  /** The monitor with its locations, components and latest state changes. */
  monitor: protectedStatusProcedure
    .input(monitorInput)
    .query(async ({ ctx, input }) => await ctx.statusMonitors.get(scopeOf(input), input.monitorId)),

  /** Create a monitor. A heartbeat's ping token is in this answer only (`heartbeatToken`, null otherwise). */
  createMonitor: protectedStatusProcedure
    .input(projectInput.and(monitorInputSchema))
    .mutation(async ({ ctx, input }) => {
      const { heartbeatToken, ...monitor } = await ctx.statusMonitors.create(
        scopeOf(input),
        ctx.session.user.id,
        input,
      );
      return { monitor, heartbeatToken };
    }),

  /** Replace the monitor's settings, locations and components; its state is kept. */
  updateMonitor: protectedStatusProcedure
    .input(monitorInput.and(monitorInputSchema))
    .mutation(async ({ ctx, input }) => ({
      monitor: await ctx.statusMonitors.update(scopeOf(input), ctx.session.user.id, input.monitorId, input),
    })),

  pauseMonitor: protectedStatusProcedure.input(monitorInput).mutation(async ({ ctx, input }) => ({
    monitor: await ctx.statusMonitors.pause(scopeOf(input), ctx.session.user.id, input.monitorId),
  })),

  resumeMonitor: protectedStatusProcedure.input(monitorInput).mutation(async ({ ctx, input }) => ({
    monitor: await ctx.statusMonitors.resume(scopeOf(input), ctx.session.user.id, input.monitorId),
  })),

  /** Issue a new ping token for a heartbeat; the old one stops working. The token is in this answer only. */
  rotateHeartbeatToken: protectedStatusProcedure
    .input(monitorInput)
    .mutation(
      async ({ ctx, input }) =>
        await ctx.statusMonitors.rotateHeartbeatToken(scopeOf(input), ctx.session.user.id, input.monitorId),
    ),

  deleteMonitor: protectedStatusProcedure.input(monitorInput).mutation(async ({ ctx, input }) => {
    await ctx.statusMonitors.delete(scopeOf(input), ctx.session.user.id, input.monitorId);
    return { ok: true } as const;
  }),

  /** The enabled hosted locations and the workspace's own; never a token or its hash. */
  locations: statusWorkspaceProcedure
    .input(workspaceInput)
    .output(z.object({ locations: z.array(locationSchema) }))
    .query(async ({ ctx, input }) => ({ locations: await ctx.statusLocations.list(input.workspaceId) })),

  /** Create a private location. The token is in this answer only. */
  createLocation: adminStatusWorkspaceProcedure
    .input(workspaceInput.and(locationInputSchema))
    .output(locationWithToken)
    .mutation(
      async ({ ctx, input }) =>
        await ctx.statusLocations.create(input.workspaceId, ctx.session.user.id, {
          code: input.code,
          name: input.name,
        }),
    ),

  /** Issue a new token for a private location; the old one stops working. */
  rotateLocationToken: adminStatusWorkspaceProcedure
    .input(locationInput)
    .output(locationWithToken)
    .mutation(
      async ({ ctx, input }) =>
        await ctx.statusLocations.rotateToken(input.workspaceId, ctx.session.user.id, input.locationId),
    ),

  disableLocation: adminStatusWorkspaceProcedure
    .input(locationInput)
    .output(z.object({ location: locationSchema }))
    .mutation(async ({ ctx, input }) => ({
      location: await ctx.statusLocations.disable(input.workspaceId, ctx.session.user.id, input.locationId),
    })),
});
