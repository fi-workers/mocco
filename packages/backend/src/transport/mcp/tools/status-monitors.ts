// `mocco_status_monitors_*` and `mocco_status_locations_search` — which checks a project
// runs, what state each is in and why it changed, and where the probes run. Read-only:
// creating, editing, pausing and resuming a monitor, and issuing a location's token, stay in
// the console.
//
// Thin adapters (ADR 0025) over the services the console's `status` router reads through:
// `MonitorService.list` / `get` for a project (behind `ProjectScope` with `Products.status`,
// so another tenant's monitor reads exactly like one that does not exist) and
// `LocationService.list` for the workspace, behind the same membership and product checks as
// the console's workspace-level `locations` query, which any member may read.
//
// What a monitor checks can carry secrets: a URL's credentials or query string, or a request
// body. So a monitor's target is only the URL's host (with its port) or a TCP host and port,
// and nothing else of its spec but the method and the timeouts ever leaves here. A location's
// token hash is never read out either.
import { Products } from '@mocco/common/project';
import { LocationKinds, MonitorKinds, MonitorStates } from '@mocco/common/status';
import { z } from 'zod';

import { monitorTargetOf } from '@backend/domain/status/monitor-target';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';
import {
  componentsOf,
  limitArg,
  MAX_LIMIT,
  projectArg,
  resolveStatusProject,
  responseFormatArg,
} from '@backend/transport/mcp/tools/status';

import type { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { LocationService } from '@backend/domain/status/LocationService';
import type { MonitorService } from '@backend/domain/status/MonitorService';
import type { LocationRow } from '@backend/domain/status/repos/location.repo';
import type { MonitorStateChangeRow } from '@backend/domain/status/repos/monitor-state-change.repo';
import type { MonitorRow } from '@backend/domain/status/repos/monitor.repo';
import type { StatusPageService } from '@backend/domain/status/StatusPageService';
import type { LocationKind, MonitorComponent, MonitorSpec, MonitorState } from '@mocco/common/status';
import type { McpServer } from '@modelcontextprotocol/server';

export interface StatusMonitorToolDeps {
  statusMonitors: Pick<MonitorService, 'list' | 'get'>;
  statusLocations: Pick<LocationService, 'list'>;
  /** For the names of the components a monitor reports on. */
  statusPages: Pick<StatusPageService, 'listPages' | 'getPage'>;
  projects: Pick<ProjectScope, 'resolve' | 'resolveWorkspace'>;
}

const monitorStates = Object.values(MonitorStates) as [MonitorState, ...MonitorState[]];
const locationKinds = Object.values(LocationKinds) as [LocationKind, ...LocationKind[]];

const afterArg = z.string().optional().describe("Cursor: the previous answer's `nextAfter`, as it was given.");

const monitorsInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  states: z
    .array(z.enum(monitorStates))
    .min(1)
    .optional()
    .describe(
      'Only monitors in these states (`pending`, `up`, `suspect`, `down`, `recovering`, `degraded`, `paused`), e.g. `["down", "degraded"]`. Omit it for every monitor.',
    ),
  query: z.string().min(1).optional().describe('Text the monitor name contains (case-insensitive).'),
  limit: limitArg,
  after: afterArg,
  responseFormat: responseFormatArg(
    'id, name, kind, target (host, or host:port), state, when it last changed and the components it reports on',
    'adds the method, interval, confirmations, quorum, timeouts, incident policy and the locations it runs at',
  ),
});

const monitorInput = z.object({
  monitorId: z.uuid().describe('The monitor id, as `mocco_status_monitors_search` returns it.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(20)
    .describe('How many of the latest state changes to return, newest first.'),
  responseFormat: responseFormatArg(
    'the monitor, its latest state changes and the incident it opened that is still open',
    'adds its settings and locations, why each state changed, and its latest closed rounds',
  ),
});

const locationsInput = z.object({
  workspaceId: workspaceArg,
  kind: z
    .enum(locationKinds)
    .optional()
    .describe("Only Mocco's `hosted` regions, the workspace's `private` ones, or the `embedded` probe."),
  limit: limitArg,
  after: afterArg,
  responseFormat: responseFormatArg(
    'id, code, name, kind, when its agent was last seen, its version and whether it is disabled',
    'adds when it was disabled and created',
  ),
});

export type SearchStatusMonitorsArgs = z.infer<typeof monitorsInput>;
export type GetStatusMonitorArgs = z.infer<typeof monitorInput>;
export type SearchStatusLocationsArgs = z.infer<typeof locationsInput>;

/** The settings an agent may see: the HTTP method and the timeouts, never the URL, body or keyword. */
const checkOf = (spec: MonitorSpec) =>
  spec.kind === MonitorKinds.http
    ? {
        method: spec.method,
        timeoutMs: spec.timeoutMs,
        latencyThresholdMs: spec.latencyThresholdMs ?? null,
        followRedirects: spec.followRedirects,
      }
    : { timeoutMs: spec.timeoutMs };

/** Ascending by a position string, one page of `limit` after `after`, and the next cursor when there is more. */
function pageAfter<T>(rows: readonly { row: T; position: string }[], args: { limit: number; after?: string }) {
  const rest = rows
    .filter(({ position }) => args.after === undefined || position > args.after)
    .toSorted((a, b) => {
      if (a.position === b.position) {
        return 0;
      }
      return a.position < b.position ? -1 : 1;
    });
  const page = rest.slice(0, args.limit);
  return {
    rows: page.map(({ row }) => row),
    // Present when there is more: pass it back as `after` for the next page.
    ...(rest.length > page.length && { nextAfter: page.at(-1)?.position }),
  };
}

type LinkedMonitor = MonitorRow & { locationIds: string[]; components: MonitorComponent[] };

/** A monitor as the tools show it; `locations` names its locations for the detailed shape. */
function monitorOf(
  monitor: LinkedMonitor,
  names: { components: Map<string, { name: string }>; locations: Map<string, LocationRow> | undefined },
) {
  const { locations } = names;
  return {
    id: monitor.id,
    name: monitor.name,
    kind: monitor.kind,
    // Only the host and port: the URL can carry credentials or a token.
    target: monitorTargetOf(monitor.spec),
    state: monitor.state,
    stateChangedAt: monitor.stateChangedAt,
    components: monitor.components.map(component => ({
      componentId: component.componentId,
      name: names.components.get(component.componentId)?.name ?? null,
      impactWhenDown: component.impactWhenDown,
    })),
    ...(locations !== undefined && {
      ...checkOf(monitor.spec),
      intervalSeconds: monitor.intervalSeconds,
      confirmations: monitor.confirmations,
      recoveryConfirmations: monitor.recoveryConfirmations,
      quorumMode: monitor.quorumMode,
      incidentPolicy: monitor.incidentPolicy,
      locations: monitor.locationIds.map(id => {
        const location = locations.get(id);
        return { id, code: location?.code ?? null, name: location?.name ?? null };
      }),
    }),
  };
}

/** What `reason` says about a change, keeping only the fields Mocco writes there. */
const reasonSchema = z.object({
  by: z.string(),
  userId: z.string().optional(),
  verdict: z.string().optional(),
  okCount: z.number().optional(),
  failCount: z.number().optional(),
  noDataCount: z.number().optional(),
});

const stateChangeOf = (change: MonitorStateChangeRow, isDetailed: boolean) => {
  const reason = reasonSchema.safeParse(change.reason);
  return {
    from: change.fromState,
    to: change.toState,
    at: change.at,
    ...(isDetailed && { roundAt: change.roundAt, reason: reason.success ? reason.data : null }),
  };
};

/** The names of the components on the project's pages. */
async function projectComponents(deps: StatusMonitorToolDeps, scope: { workspaceId: string; projectId: string }) {
  const pages = await deps.statusPages.listPages(scope);
  return await componentsOf(
    deps,
    scope,
    pages.map(page => page.id),
  );
}

async function locationsById(deps: StatusMonitorToolDeps, workspaceId: string) {
  const locations = await deps.statusLocations.list(workspaceId);
  return new Map(locations.map(location => [location.id, location] as const));
}

export async function searchStatusMonitors(
  deps: StatusMonitorToolDeps,
  args: SearchStatusMonitorsArgs,
  userId: string,
) {
  const scope = await resolveStatusProject(deps, userId, args);
  const isDetailed = args.responseFormat === 'detailed';
  const [monitors, components, locations] = await Promise.all([
    deps.statusMonitors.list(scope),
    projectComponents(deps, scope),
    isDetailed ? locationsById(deps, scope.workspaceId) : undefined,
  ]);
  const needle = args.query?.toLowerCase();
  const matching = monitors
    .filter(
      monitor =>
        (args.states === undefined || args.states.includes(monitor.state)) &&
        (needle === undefined || monitor.name.toLowerCase().includes(needle)),
    )
    .map(monitor => ({ row: monitor, position: `${monitor.name}~${monitor.id}` }));
  const { rows, ...more } = pageAfter(matching, args);
  return { monitors: rows.map(monitor => monitorOf(monitor, { components, locations })), ...more };
}

export async function getStatusMonitor(deps: StatusMonitorToolDeps, args: GetStatusMonitorArgs, userId: string) {
  const scope = await resolveStatusProject(deps, userId, args);
  const isDetailed = args.responseFormat === 'detailed';
  // The monitor first: it is the read that refuses a monitor outside the project. Started
  // alongside the name lookups, a refusal would return while their queries were still running,
  // and they would outlive the request.
  const { monitor, stateChanges, recentVerdicts, openIncident } = await deps.statusMonitors.get(scope, args.monitorId);
  const [components, locations] = await Promise.all([
    projectComponents(deps, scope),
    isDetailed ? locationsById(deps, scope.workspaceId) : undefined,
  ]);
  return {
    monitor: monitorOf(monitor, { components, locations }),
    // The incident this monitor opened when it went down, until it recovers.
    openIncident:
      openIncident === null
        ? null
        : {
            id: openIncident.id,
            pageId: openIncident.pageId,
            title: openIncident.title,
            status: openIncident.status,
            severity: openIncident.severity,
            visibility: openIncident.visibility,
            startedAt: openIncident.startedAt,
          },
    stateChanges: stateChanges.slice(0, args.limit).map(change => stateChangeOf(change, isDetailed)),
    ...(isDetailed && {
      recentRounds: recentVerdicts.map(round => ({
        roundAt: round.roundAt,
        verdict: round.verdict,
        okCount: round.okCount,
        failCount: round.failCount,
        noDataCount: round.noDataCount,
        p50LatencyMs: round.p50LatencyMs,
      })),
    }),
  };
}

export async function searchStatusLocations(
  deps: StatusMonitorToolDeps,
  args: SearchStatusLocationsArgs,
  userId: string,
) {
  const workspaceId = await deps.projects.resolveWorkspace(userId, args.workspaceId, Products.status);
  const locations = await deps.statusLocations.list(workspaceId);
  const matching = locations
    .filter(location => args.kind === undefined || location.kind === args.kind)
    .map(location => ({ row: location, position: `${location.kind}~${location.code}~${location.id}` }));
  const { rows, ...more } = pageAfter(matching, args);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    // Never the token hash: a location's token is a credential, shown once when it is issued.
    locations: rows.map(location => ({
      id: location.id,
      code: location.code,
      name: location.name,
      kind: location.kind,
      lastSeenAt: location.lastSeenAt,
      agentVersion: location.agentVersion,
      isDisabled: location.disabledAt !== null,
      ...(isDetailed && { disabledAt: location.disabledAt, createdAt: location.createdAt }),
    })),
    ...more,
  };
}

export function registerStatusMonitorTools(server: McpServer, deps: StatusMonitorToolDeps): void {
  server.registerTool(
    'mocco_status_monitors_search',
    {
      title: 'Find status monitors',
      description:
        "A project's HTTP and TCP monitors by name: what each checks (host only), its state (up, suspect, down, recovering, degraded, paused or pending) and since when, and the components it reports on. Filter by state, e.g. the ones down. Read-only.",
      inputSchema: monitorsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchStatusMonitors(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_status_monitors_get',
    {
      title: 'Read a status monitor',
      description:
        'One monitor: its state, its latest state changes newest first, and the incident it opened that is still open; detailed adds its settings, why each change happened and its latest closed rounds. Read-only.',
      inputSchema: monitorInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getStatusMonitor(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_status_locations_search',
    {
      title: 'Find probe locations',
      description:
        "Where the workspace's monitors can run: Mocco's hosted regions, the workspace's private locations and the embedded probe, with when each agent was last seen and its version. Never a token. Read-only.",
      inputSchema: locationsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchStatusLocations(deps, args, userIdOf(ctx))),
  );
}
