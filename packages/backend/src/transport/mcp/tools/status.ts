// `mocco_status_*` — what a project's status pages say now, which incidents are open (or
// were), each incident's timeline, and the maintenance windows ahead. Read-only: opening
// an incident, posting an update, setting a component's status and scheduling
// maintenance are things a person says to their customers, and a tool that does them
// needs its own design pass.
//
// Thin adapters (ADR 0025) over the services the console's `status` router reads through.
// Status is project-scoped, so every call first goes through `ProjectScope` — membership,
// the status product, the project in that workspace — with the caller's own id. Pages,
// incidents and windows are then looked up only inside that project, so another tenant's
// id reads exactly like one that does not exist. The filtering and paging here only
// narrow what the services returned; they decide nothing, and every status shown is the
// one the service derived.
import { Products } from '@mocco/common/project';
import { IncidentSeverities, IncidentStatuses, MaintenanceStatuses } from '@mocco/common/status';
import { z } from 'zod';

import { StatusPageUnclearError } from '@backend/domain/mcp/errors';
import { StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { ProjectInScope, ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { IncidentService } from '@backend/domain/status/IncidentService';
import type { MaintenanceService } from '@backend/domain/status/MaintenanceService';
import type { StatusPageRow } from '@backend/domain/status/repos/page.repo';
import type { StatusPageService } from '@backend/domain/status/StatusPageService';
import type { IncidentSeverity, IncidentStatus, MaintenanceStatus } from '@mocco/common/status';
import type { McpServer } from '@modelcontextprotocol/server';

export interface StatusToolDeps {
  /** Finds the project's pages (the scoping step) and what each component shows. */
  statusPages: Pick<StatusPageService, 'listPages' | 'getPage'>;
  statusIncidents: Pick<IncidentService, 'list' | 'get'>;
  statusMaintenances: Pick<MaintenanceService, 'list'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const projectArg = z
  .uuid()
  .optional()
  .describe('The project the status page belongs to. Omit it when the workspace has exactly one.');

const responseFormatArg = (concise: string, detailed: string) =>
  z.enum(['concise', 'detailed']).default('concise').describe(`\`concise\` is ${concise}; \`detailed\` ${detailed}.`);

const limitArg = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);
const beforeArg = z.string().optional().describe("Cursor: the previous answer's `nextBefore`, as it was given.");

/** Incidents still open, every incident, or those in one lifecycle status. */
const IncidentFilters = { open: 'open', all: 'all', ...IncidentStatuses } as const;
type IncidentFilter = (typeof IncidentFilters)[keyof typeof IncidentFilters];
const incidentFilters = Object.values(IncidentFilters) as [IncidentFilter, ...IncidentFilter[]];
const severities = Object.values(IncidentSeverities) as [IncidentSeverity, ...IncidentSeverity[]];

/** Windows still ahead or running, every window, or those in one lifecycle status. */
const MaintenanceFilters = { upcoming: 'upcoming', all: 'all', ...MaintenanceStatuses } as const;
type MaintenanceFilter = (typeof MaintenanceFilters)[keyof typeof MaintenanceFilters];
const maintenanceFilters = Object.values(MaintenanceFilters) as [MaintenanceFilter, ...MaintenanceFilter[]];

const pageInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  pageId: z.uuid().optional().describe('The status page. Omit it when the project has exactly one.'),
  responseFormat: responseFormatArg(
    'each component with the status the page shows for it',
    "adds the component descriptions, the status an operator set by hand, and the page's groups",
  ),
});

const incidentsInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  pageId: z.uuid().optional().describe("Only this status page's incidents. Omit it for every page of the project."),
  status: z
    .enum(incidentFilters)
    .default(IncidentFilters.open)
    .describe(
      '`open` is every incident not yet resolved; `all` includes resolved ones; or one status (`investigating`, `identified`, `monitoring`, `resolved`).',
    ),
  severity: z.enum(severities).optional().describe('Only incidents of this severity.'),
  query: z.string().min(1).optional().describe('Text the incident title contains (case-insensitive).'),
  limit: limitArg,
  before: beforeArg,
  responseFormat: responseFormatArg(
    'id, page, title, status, severity and when it started and resolved',
    'adds the affected components with their impact and the latest update',
  ),
});

const incidentInput = z.object({
  incidentId: z.uuid().describe('The incident id, as `mocco_status_incidents_search` returns it.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
  responseFormat: responseFormatArg(
    'the incident, its affected components and every update, oldest first',
    'adds the postmortem, who posted each update and what each affected component shows now',
  ),
});

const maintenancesInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  pageId: z.uuid().optional().describe("Only this status page's windows. Omit it for every page of the project."),
  status: z
    .enum(maintenanceFilters)
    .default(MaintenanceFilters.upcoming)
    .describe(
      '`upcoming` is every window scheduled or in progress; `all` includes completed and canceled ones; or one status.',
    ),
  limit: limitArg,
  before: beforeArg,
  responseFormat: responseFormatArg(
    'id, page, title, status and the scheduled start and end',
    'adds the description, when it actually started and ended, and the components it covers',
  ),
});

export type GetStatusPageArgs = z.infer<typeof pageInput>;
export type SearchStatusIncidentsArgs = z.infer<typeof incidentsInput>;
export type GetStatusIncidentArgs = z.infer<typeof incidentInput>;
export type SearchStatusMaintenancesArgs = z.infer<typeof maintenancesInput>;

const resolveStatusProject = async (deps: StatusToolDeps, userId: string, asked: Partial<ProjectInScope>) =>
  await deps.projects.resolve(userId, asked, Products.status);

const pageSummary = (page: StatusPageRow) => ({ id: page.id, slug: page.slug, title: page.title });

/**
 * The pages a search reads: the named one, or every page of the project. A page of
 * another project reads exactly like one that does not exist.
 */
async function pagesToRead(deps: StatusToolDeps, scope: ProjectInScope, pageId: string | undefined) {
  const pages = await deps.statusPages.listPages(scope);
  if (pageId === undefined) {
    return pages;
  }
  const page = pages.find(each => each.id === pageId);
  if (page === undefined) {
    throw new StatusEntityNotFoundError('page', pageId);
  }
  return [page];
}

/** The one page a read is about: the named one, or the project's only page. */
async function onePage(deps: StatusToolDeps, scope: ProjectInScope, pageId: string | undefined) {
  if (pageId !== undefined) {
    return pageId;
  }
  const pages = await deps.statusPages.listPages(scope);
  const [only] = pages;
  if (pages.length !== 1 || only === undefined) {
    throw new StatusPageUnclearError(pages.map(each => ({ id: each.id, name: each.title })));
  }
  return only.id;
}

/** Every component of these pages by id, with its name and the status it shows now. */
async function componentsOf(deps: StatusToolDeps, scope: ProjectInScope, pageIds: readonly string[]) {
  const read = await Promise.all([...new Set(pageIds)].map(async id => await deps.statusPages.getPage(scope, id)));
  return new Map(read.flatMap(({ components }) => components.map(component => [component.id, component] as const)));
}

/**
 * Where a row sits in newest-first order, as a string that sorts the same way. The id
 * breaks ties between rows with the same time.
 */
const positionOf = (at: Date, id: string) => `${at.toISOString()}~${id}`;

/** Compares positions by code unit, which is the order `before` filters by. */
function newestFirst(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? 1 : -1;
}

/** Newest first from `before`, one page of `limit`, and the cursor for the next page when there is one. */
function pageOf<T>(rows: readonly { row: T; position: string }[], args: { limit: number; before?: string }) {
  const after = rows
    .filter(({ position }) => args.before === undefined || position < args.before)
    .toSorted((a, b) => newestFirst(a.position, b.position));
  const page = after.slice(0, args.limit);
  return {
    rows: page.map(({ row }) => row),
    // Present when there is more: pass it back as `before` for the next page.
    ...(after.length > page.length && { nextBefore: page.at(-1)?.position }),
  };
}

export async function getStatusPage(deps: StatusToolDeps, args: GetStatusPageArgs, userId: string) {
  const scope = await resolveStatusProject(deps, userId, args);
  const pageId = await onePage(deps, scope, args.pageId);
  const { page, groups, components } = await deps.statusPages.getPage(scope, pageId);
  const groupName = (groupId: string | null) => groups.find(group => group.id === groupId)?.name ?? null;
  const isDetailed = args.responseFormat === 'detailed';
  return {
    page: pageSummary(page),
    components: components.map(component => ({
      id: component.id,
      name: component.name,
      group: groupName(component.groupId),
      // What the page shows: the worst of the status set by hand, the open incidents
      // affecting it, and maintenance in progress.
      status: component.displayedStatus,
      ...(isDetailed && {
        description: component.description,
        manualStatus: component.status,
        groupId: component.groupId,
        updatedAt: component.updatedAt,
      }),
    })),
    ...(isDetailed && { groups: groups.map(group => ({ id: group.id, name: group.name })) }),
  };
}

const isOpenOnlyFor = (filter: IncidentFilter) =>
  filter === IncidentFilters.open || (filter !== IncidentFilters.all && filter !== IncidentStatuses.resolved);

const isIncidentInFilter = (filter: IncidentFilter, status: IncidentStatus) =>
  [IncidentFilters.open, IncidentFilters.all, status].includes(filter);

export async function searchStatusIncidents(deps: StatusToolDeps, args: SearchStatusIncidentsArgs, userId: string) {
  const scope = await resolveStatusProject(deps, userId, args);
  const pages = await pagesToRead(deps, scope, args.pageId);
  const isOpenOnly = isOpenOnlyFor(args.status);
  const listed = await Promise.all(
    pages.map(async page => await deps.statusIncidents.list(scope, page.id, isOpenOnly)),
  );
  const needle = args.query?.toLowerCase();
  const matching = listed
    .flat()
    .filter(
      incident =>
        isIncidentInFilter(args.status, incident.status) &&
        (args.severity === undefined || incident.severity === args.severity) &&
        (needle === undefined || incident.title.toLowerCase().includes(needle)),
    )
    .map(incident => ({ row: incident, position: positionOf(incident.startedAt, incident.id) }));
  const { rows, ...more } = pageOf(matching, args);

  const isDetailed = args.responseFormat === 'detailed';
  const read = isDetailed
    ? await Promise.all(rows.map(async incident => await deps.statusIncidents.get(scope, incident.id)))
    : [];
  const components = await componentsOf(deps, scope, isDetailed ? rows.map(incident => incident.pageId) : []);
  return {
    pages: pages.map(page => pageSummary(page)),
    incidents: rows.map(incident => {
      const detail = read.find(each => each.incident.id === incident.id);
      const latest = detail?.updates.at(-1);
      return {
        id: incident.id,
        pageId: incident.pageId,
        title: incident.title,
        status: incident.status,
        severity: incident.severity,
        startedAt: incident.startedAt,
        resolvedAt: incident.resolvedAt,
        ...(detail !== undefined && {
          identifiedAt: incident.identifiedAt,
          affectedComponents: detail.components.map(each => ({
            componentId: each.componentId,
            name: components.get(each.componentId)?.name ?? null,
            impact: each.impact,
          })),
          latestUpdate:
            latest === undefined ? null : { status: latest.status, body: latest.bodyMd, createdAt: latest.createdAt },
        }),
      };
    }),
    ...more,
  };
}

export async function getStatusIncident(deps: StatusToolDeps, args: GetStatusIncidentArgs, userId: string) {
  const scope = await resolveStatusProject(deps, userId, args);
  const { incident, updates, components: affected } = await deps.statusIncidents.get(scope, args.incidentId);
  const { page, components } = await deps.statusPages.getPage(scope, incident.pageId);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    incident: {
      id: incident.id,
      title: incident.title,
      status: incident.status,
      severity: incident.severity,
      startedAt: incident.startedAt,
      identifiedAt: incident.identifiedAt,
      resolvedAt: incident.resolvedAt,
      hasPostmortem: incident.postmortemMd !== null,
      ...(isDetailed && { postmortem: incident.postmortemMd, createdByUserId: incident.createdByUserId }),
    },
    page: pageSummary(page),
    affectedComponents: affected.map(each => {
      const component = components.find(candidate => candidate.id === each.componentId);
      return {
        componentId: each.componentId,
        name: component?.name ?? null,
        impact: each.impact,
        ...(isDetailed && { status: component?.displayedStatus ?? null }),
      };
    }),
    updates: updates.map(update => ({
      status: update.status,
      body: update.bodyMd,
      createdAt: update.createdAt,
      ...(isDetailed && { id: update.id, authorUserId: update.authorUserId }),
    })),
  };
}

const isWindowInFilter = (filter: MaintenanceFilter, status: MaintenanceStatus) =>
  filter === MaintenanceFilters.all ||
  filter === status ||
  (filter === MaintenanceFilters.upcoming &&
    (status === MaintenanceStatuses.scheduled || status === MaintenanceStatuses.inProgress));

export async function searchStatusMaintenances(
  deps: StatusToolDeps,
  args: SearchStatusMaintenancesArgs,
  userId: string,
) {
  const scope = await resolveStatusProject(deps, userId, args);
  const pages = await pagesToRead(deps, scope, args.pageId);
  const listed = await Promise.all(pages.map(async page => await deps.statusMaintenances.list(scope, page.id)));
  const matching = listed
    .flat()
    .filter(window => isWindowInFilter(args.status, window.status))
    .map(window => ({ row: window, position: positionOf(window.scheduledStart, window.id) }));
  const { rows, ...more } = pageOf(matching, args);

  const isDetailed = args.responseFormat === 'detailed';
  const components = await componentsOf(deps, scope, isDetailed ? rows.map(window => window.pageId) : []);
  return {
    pages: pages.map(page => pageSummary(page)),
    maintenances: rows.map(window => ({
      id: window.id,
      pageId: window.pageId,
      title: window.title,
      status: window.status,
      scheduledStart: window.scheduledStart,
      scheduledEnd: window.scheduledEnd,
      ...(isDetailed && {
        body: window.bodyMd,
        actualStart: window.actualStart,
        actualEnd: window.actualEnd,
        components: window.componentIds.map(componentId => ({
          componentId,
          name: components.get(componentId)?.name ?? null,
        })),
      }),
    })),
    ...more,
  };
}

export function registerStatusTools(server: McpServer, deps: StatusToolDeps): void {
  server.registerTool(
    'mocco_status_pages_get',
    {
      title: 'Read a status page',
      description:
        "What a project's status page says right now: each component and the status it shows, derived from the status set by hand, open incidents and maintenance in progress. Read-only.",
      inputSchema: pageInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getStatusPage(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_status_incidents_search',
    {
      title: 'Find status incidents',
      description:
        "A project's status page incidents, newest first: open ones unless asked otherwise, by status, severity, page or title text. Looks at each page's 200 most recent incidents. Read-only.",
      inputSchema: incidentsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchStatusIncidents(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_status_incidents_get',
    {
      title: 'Read a status incident',
      description:
        'One status page incident: every update posted to it, oldest first, the components it affects and how badly, and whether it has a postmortem. Read-only.',
      inputSchema: incidentInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getStatusIncident(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_status_maintenances_search',
    {
      title: 'Find maintenance windows',
      description:
        "A project's scheduled maintenance windows, latest start first: those scheduled or in progress unless asked otherwise. Looks at each page's 200 most recent windows. Read-only.",
      inputSchema: maintenancesInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchStatusMaintenances(deps, args, userIdOf(ctx))),
  );
}
