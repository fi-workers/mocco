// `mocco_status_monitors_*` and `mocco_status_locations_search` — which checks a project
// runs, what state each is in and why it changed, and where the probes run — and
// `mocco_monitors_check`, which asks for a monitor's next round now. Creating, editing,
// pausing and resuming a monitor, and issuing a location's token, stay in the console.
//
// Thin adapters (ADR 0025) over the services the console's `status` router reads through:
// `MonitorService.list` / `get` for a project (behind `ProjectScope` with `Products.status`,
// so another tenant's monitor reads exactly like one that does not exist) and
// `LocationService.list` for the workspace, behind the same membership and product checks as
// the console's workspace-level `locations` query, which any member may read. The check is
// `MonitorService.requestCheck`, what `POST /v1/monitors/:id/check` calls, behind the same
// `ProjectScope`.
//
// The check needs `status:write`, stepped up for like the deciding tools' scope, but it is no
// decision: it changes no setting and says nothing to anyone, it only moves the next round of
// probes to now — the round they would run anyway within the monitor's interval. So it has
// neither the workspace's opt-in nor a confirmation round trip; the scope is the person's
// consent that this app may ask for checks.
//
// What a monitor checks can carry secrets: a URL's credentials or query string, or a request
// body. So a monitor's target is only the URL's host (with its port) or a TCP host and port,
// and nothing else of its spec but the method and the timeouts ever leaves here. A location's
// token hash, and a heartbeat's ping token and its hash, are never read out either.
import { McpScopes } from '@mocco/common/mcp';
import { Products } from '@mocco/common/project';
import { isProbeSpec, LocationKinds, MonitorKinds, MonitorStates } from '@mocco/common/status';
import { z } from 'zod';

import { ConflictError, NotFoundError } from '@backend/domain/errors';
import { monitorTargetOf } from '@backend/domain/status/monitor-target';
import { refused, requireScope } from '@backend/transport/mcp/tools/deciding';
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
import type { MonitorService, MonitorView } from '@backend/domain/status/MonitorService';
import type { LocationRow } from '@backend/domain/status/repos/location.repo';
import type { MonitorStateChangeRow } from '@backend/domain/status/repos/monitor-state-change.repo';
import type { StatusPageService } from '@backend/domain/status/StatusPageService';
import type { LocationKind, MonitorComponent, MonitorSpec, MonitorState } from '@mocco/common/status';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface StatusMonitorToolDeps {
  statusMonitors: Pick<MonitorService, 'list' | 'get' | 'requestCheck'>;
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

const checkInput = z.object({
  monitorId: z.uuid().describe('The HTTP or TCP monitor to check, as `mocco_status_monitors_search` returns it.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

export type SearchStatusMonitorsArgs = z.infer<typeof monitorsInput>;
export type GetStatusMonitorArgs = z.infer<typeof monitorInput>;
export type SearchStatusLocationsArgs = z.infer<typeof locationsInput>;
export type CheckMonitorArgs = z.infer<typeof checkInput>;

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

/** A heartbeat's settings and its last ping and run, never its token. */
const heartbeatOf = (monitor: MonitorView) => ({
  periodSeconds: monitor.heartbeatPeriodSeconds,
  graceSeconds: monitor.heartbeatGraceSeconds,
  lastPingAt: monitor.lastPingAt,
  lastStartAt: monitor.lastStartAt,
  lastDurationMs: monitor.lastDurationMs,
});

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

type LinkedMonitor = MonitorView & { locationIds: string[]; components: MonitorComponent[] };

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
    // A heartbeat checks nothing itself, so when its job last pinged is what says it is alive.
    ...(!isProbeSpec(monitor.spec) && { heartbeat: heartbeatOf(monitor) }),
    ...(locations !== undefined && {
      ...(isProbeSpec(monitor.spec) && checkOf(monitor.spec)),
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
  /** A heartbeat's: `success`, `fail` (with the job's `exitCode`, if it sent one) or `silence`. */
  cause: z.string().optional(),
  exitCode: z.number().optional(),
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
  const { monitor, stateChanges, recentVerdicts, openIncident, history } = await deps.statusMonitors.get(
    scope,
    args.monitorId,
  );
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
      // The last 48 hours and 90 days of uptime and p50/p95 latency, from the rollups.
      history,
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

/** Run the monitor's next round now. Refusals come back as tool errors the model can act on. */
export async function checkMonitor(
  deps: StatusMonitorToolDeps,
  args: CheckMonitorArgs,
  ctx: ServerContext,
): Promise<CallToolResult> {
  // The HTTP layer has already challenged a token without the scope; checked again here, where
  // the check is asked for, in case anything ever routes around it.
  if (!(ctx.http?.authInfo?.scopes.includes(McpScopes.statusWrite) ?? false)) {
    return refused(
      "This connection may not run checks. Reconnect the app and allow it to run your status monitors' checks.",
    );
  }
  const scope = await resolveStatusProject(deps, userIdOf(ctx), args);
  try {
    const round = await deps.statusMonitors.requestCheck(scope, args.monitorId);
    return asJson({
      monitorId: round.monitorId,
      roundAt: round.roundAt,
      next: 'The probes run this round now; its verdict follows when they report. Read it with `mocco_status_monitors_get` (detailed) in a minute or so.',
    });
  } catch (error) {
    // Not found (another tenant's monitor reads the same), a heartbeat, or a paused monitor.
    if (error instanceof NotFoundError || error instanceof ConflictError) {
      return refused(error.message);
    }
    throw error;
  }
}

export function registerStatusMonitorTools(server: McpServer, deps: StatusMonitorToolDeps): void {
  server.registerTool(
    'mocco_status_monitors_search',
    {
      title: 'Find status monitors',
      description:
        "A project's HTTP, TCP and heartbeat monitors by name: what each checks (host only; none for a heartbeat, which its job pings, so a heartbeat shows its period, grace and last ping and run instead), its state (up, suspect, down, recovering, degraded, paused or pending) and since when, and the components it reports on. Filter by state, e.g. the ones down. Read-only.",
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
        'One monitor: its state, its latest state changes newest first, and the incident it opened that is still open; detailed adds its settings, why each change happened, its latest closed rounds, and its uptime and p50/p95 latency for the last 48 hours and 90 days. Read-only.',
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

  server.registerTool(
    'mocco_monitors_check',
    {
      title: 'Check a monitor now',
      description:
        "Run an HTTP or TCP monitor's next round now instead of waiting for its interval, e.g. right after a deploy, as the signed-in person; the answer says when the round is, and its verdict follows when the probes report. A round already due is not moved. Changes no setting and needs no confirmation. Refused for a heartbeat (its job pings it) and for a paused monitor.",
      inputSchema: checkInput,
      // It runs probes against the monitored service, and a second call while the round is
      // due changes nothing.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      scopeChallenge: requireScope(
        McpScopes.statusWrite,
        "Checking a monitor needs your permission for this app to run your status monitors' checks",
      ),
    },
    async (args, ctx) => await checkMonitor(deps, args, ctx),
  );
}
