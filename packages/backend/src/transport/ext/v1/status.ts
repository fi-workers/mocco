// The /v1 status management API (#159): monitors as code, upserted by a key the caller chooses,
// incidents and their updates, maintenance windows, and the components of the project's pages,
// for CI and scripts. A secret key of the project: reads need `status:read`, changes
// `status:write`. Another project's monitor, page, incident or window answers 404, like one that
// doesn't exist. The routes only parse and map errors; the status services decide, and record
// each change as the key acting for the person who created it.
//
// Every answer is built field by field from the service's rows (the `*Of` functions below) and
// then parsed by its `@mocco/common/status-v1` schema, which drops anything it doesn't list. A
// monitor's URL path, query and credentials, its request body, its heartbeat token's hash and
// every row's workspace id never leave here.
import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import {
  incidentCreateInputSchema,
  incidentUpdateInputSchema,
  isProbeSpec,
  MonitorKinds,
  monitorInputSchema,
} from '@mocco/common/status';
import {
  MonitorUpsertOutcomes,
  statusMonitorKeySchema,
  statusV1ComponentListSchema,
  statusV1ComponentSchema,
  statusV1ComponentStatusInputSchema,
  statusV1IncidentComponentsInputSchema,
  statusV1IncidentDetailSchema,
  statusV1IncidentListQuerySchema,
  statusV1IncidentListSchema,
  statusV1IncidentUpdateResultSchema,
  statusV1LocationListSchema,
  statusV1MaintenanceInputSchema,
  statusV1MaintenanceListSchema,
  statusV1MaintenanceSchema,
  statusV1MonitorListSchema,
  statusV1MonitorSchema,
  statusV1MonitorUpsertResultSchema,
  statusV1PageListSchema,
  statusV1PageQuerySchema,
} from '@mocco/common/status-v1';
import { Hono } from 'hono';
import { z } from 'zod';

import { BadRequestError, ConflictError, NotFoundError } from '@backend/domain/errors';
import { monitorTargetOf } from '@backend/domain/status/monitor-target';
import { requireKey } from '@backend/transport/ext/v1/middleware';
import { parseJson, problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { ApiPrincipal } from '@backend/domain/apikey/ApiKeyService';
import type { StatusDomain } from '@backend/domain/status/compose';
import type { IncidentService } from '@backend/domain/status/IncidentService';
import type { LocationService } from '@backend/domain/status/LocationService';
import type { MaintenanceService } from '@backend/domain/status/MaintenanceService';
import type { MonitorService } from '@backend/domain/status/MonitorService';
import type { ComponentRow } from '@backend/domain/status/repos/component.repo';
import type { IncidentComponentRow } from '@backend/domain/status/repos/incident-component.repo';
import type { IncidentUpdateRow } from '@backend/domain/status/repos/incident-update.repo';
import type { IncidentRow } from '@backend/domain/status/repos/incident.repo';
import type { LocationRow } from '@backend/domain/status/repos/location.repo';
import type { MaintenanceRow } from '@backend/domain/status/repos/maintenance.repo';
import type { StatusPageRow } from '@backend/domain/status/repos/page.repo';
import type { StatusActor, StatusScope } from '@backend/domain/status/scope';
import type { StatusPageService } from '@backend/domain/status/StatusPageService';
import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';
import type { ComponentStatus, MonitorSpec } from '@mocco/common/status';
import type { Context } from 'hono';

export interface StatusApiDeps {
  monitors: Pick<MonitorService, 'list' | 'find' | 'upsertByKey' | 'pause' | 'resume' | 'delete' | 'requestCheck'>;
  incidents: Pick<IncidentService, 'list' | 'get' | 'create' | 'postUpdate' | 'setComponents'>;
  maintenances: Pick<MaintenanceService, 'list' | 'schedule' | 'cancel'>;
  pages: Pick<StatusPageService, 'listPages' | 'getPage' | 'setComponentStatus'>;
  locations: Pick<LocationService, 'list'>;
}

/** The status API's services, from the domain's composition. */
export const statusApiDepsOf = (status: StatusDomain): StatusApiDeps => ({
  monitors: status.statusMonitors,
  incidents: status.statusIncidents,
  maintenances: status.statusMaintenances,
  pages: status.statusPages,
  locations: status.statusLocations,
});

const iso = (at: Date) => at.toISOString();
const isoOrNull = (at: Date | null) => (at === null ? null : at.toISOString());

type LinkedMonitor = Awaited<ReturnType<MonitorService['find']>>;

/** A probe check's settings that can't hold a secret: never its URL beyond the host, nor its body. */
const checkOf = (spec: MonitorSpec): NonNullable<z.input<typeof statusV1MonitorSchema>['check']> =>
  spec.kind === MonitorKinds.http
    ? {
        method: spec.method,
        expectedStatus: spec.expectedStatus,
        latencyThresholdMs: spec.latencyThresholdMs ?? null,
        timeoutMs: spec.timeoutMs,
        followRedirects: spec.followRedirects,
        tlsWarnDays: spec.tlsWarnDays ?? null,
      }
    : {
        method: null,
        expectedStatus: [],
        latencyThresholdMs: null,
        timeoutMs: spec.timeoutMs,
        followRedirects: null,
        tlsWarnDays: null,
      };

/** A heartbeat's period and grace (the DB requires both on a heartbeat) and its last ping and run. */
const heartbeatOf = (
  monitor: LinkedMonitor,
  periodSeconds: number,
  graceSeconds: number,
): NonNullable<z.input<typeof statusV1MonitorSchema>['heartbeat']> => ({
  periodSeconds,
  graceSeconds,
  lastPingAt: isoOrNull(monitor.lastPingAt),
  lastStartAt: isoOrNull(monitor.lastStartAt),
  lastDurationMs: monitor.lastDurationMs,
});

const monitorOf = (monitor: LinkedMonitor): z.input<typeof statusV1MonitorSchema> => ({
  id: monitor.id,
  key: monitor.key,
  name: monitor.name,
  kind: monitor.kind,
  // Only the host and port: the URL can carry credentials or a token.
  target: monitorTargetOf(monitor.spec),
  state: monitor.state,
  stateChangedAt: iso(monitor.stateChangedAt),
  check: isProbeSpec(monitor.spec) ? checkOf(monitor.spec) : null,
  heartbeat:
    monitor.heartbeatPeriodSeconds === null || monitor.heartbeatGraceSeconds === null
      ? null
      : heartbeatOf(monitor, monitor.heartbeatPeriodSeconds, monitor.heartbeatGraceSeconds),
  intervalSeconds: monitor.intervalSeconds,
  confirmations: monitor.confirmations,
  recoveryConfirmations: monitor.recoveryConfirmations,
  quorumMode: monitor.quorumMode,
  incidentPolicy: monitor.incidentPolicy,
  locationIds: monitor.locationIds,
  components: monitor.components,
  createdAt: iso(monitor.createdAt),
  updatedAt: iso(monitor.updatedAt),
});

const locationOf = (location: LocationRow) => ({
  id: location.id,
  code: location.code,
  name: location.name,
  kind: location.kind,
  disabled: location.disabledAt !== null,
});

const pageOf = (page: StatusPageRow) => ({
  id: page.id,
  slug: page.slug,
  title: page.title,
  createdAt: iso(page.createdAt),
  updatedAt: iso(page.updatedAt),
});

const componentOf = (
  component: ComponentRow & { displayedStatus: ComponentStatus },
): z.input<typeof statusV1ComponentSchema> => ({
  id: component.id,
  pageId: component.pageId,
  groupId: component.groupId,
  name: component.name,
  description: component.description,
  position: component.position,
  status: component.status,
  displayedStatus: component.displayedStatus,
  updatedAt: iso(component.updatedAt),
});

const incidentOf = (incident: IncidentRow) => ({
  id: incident.id,
  pageId: incident.pageId,
  title: incident.title,
  status: incident.status,
  severity: incident.severity,
  visibility: incident.visibility,
  origin: incident.origin,
  startedAt: iso(incident.startedAt),
  identifiedAt: isoOrNull(incident.identifiedAt),
  resolvedAt: isoOrNull(incident.resolvedAt),
  createdAt: iso(incident.createdAt),
  updatedAt: iso(incident.updatedAt),
});

const incidentUpdateOf = (update: IncidentUpdateRow) => ({
  id: update.id,
  status: update.status,
  body: update.bodyMd,
  createdAt: iso(update.createdAt),
});

const incidentDetailOf = (detail: {
  incident: IncidentRow;
  updates: readonly IncidentUpdateRow[];
  components: readonly IncidentComponentRow[];
}) => ({
  incident: incidentOf(detail.incident),
  updates: detail.updates.map(update => incidentUpdateOf(update)),
  components: detail.components.map(component => ({ componentId: component.componentId, impact: component.impact })),
});

const maintenanceOf = (maintenance: MaintenanceRow & { componentIds: string[] }) => ({
  id: maintenance.id,
  pageId: maintenance.pageId,
  title: maintenance.title,
  body: maintenance.bodyMd,
  status: maintenance.status,
  scheduledStart: iso(maintenance.scheduledStart),
  scheduledEnd: iso(maintenance.scheduledEnd),
  actualStart: isoOrNull(maintenance.actualStart),
  actualEnd: isoOrNull(maintenance.actualEnd),
  componentIds: maintenance.componentIds,
  runId: maintenance.runId,
  overranAt: isoOrNull(maintenance.overranAt),
  endNote: maintenance.endNote,
  createdAt: iso(maintenance.createdAt),
  updatedAt: iso(maintenance.updatedAt),
});

/** Answer `body` narrowed by `schema`: a field the schema doesn't list never reaches the caller. */
const answer = <S extends z.ZodType>(c: Context<V1Env>, schema: S, body: z.input<S>, status: 200 | 201 = 200) =>
  c.json(schema.parse(body), status);

const notFound = (detail: string) => problemResponse(problemOf(404, ProblemCodes.notFound, 'Not found', detail));

/** The status domain's errors as problems; anything else is rethrown. */
function problemFor(error: unknown): Response {
  if (error instanceof NotFoundError) {
    return notFound(error.message);
  }
  if (error instanceof ConflictError) {
    return problemResponse(problemOf(409, ProblemCodes.conflict, 'Conflict', error.message));
  }
  if (error instanceof BadRequestError) {
    return problemResponse(problemOf(400, ProblemCodes.badRequest, 'Invalid request', error.message));
  }
  throw error;
}

/** Run a handler, answering the status domain's errors as problems. */
async function mapped(handle: () => Promise<Response>): Promise<Response> {
  try {
    return await handle();
  } catch (error) {
    return problemFor(error);
  }
}

const idSchema = z.uuid();

/** A path id; undefined for one that isn't a uuid, which can't name anything (a 404). */
const pathId = (c: Context<V1Env>, name: string): string | undefined => idSchema.safeParse(c.req.param(name)).data;

/** A 400 problem naming a query's first issue. */
function invalidQuery(error: z.ZodError): Response {
  const [issue] = error.issues;
  const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
  return problemResponse(
    problemOf(400, ProblemCodes.badRequest, 'Invalid request', `${where}${issue?.message ?? 'invalid'}`),
  );
}

const scopeOf = (principal: ApiPrincipal): StatusScope => ({
  workspaceId: principal.workspaceId,
  projectId: principal.projectId,
});

/** A key acts for the person who created it, and is named in the audit log. */
const actorFor = (principal: ApiPrincipal): StatusActor => ({
  userId: principal.createdByUserId,
  apiKeyId: principal.keyId,
});

export function createStatusApiRoutes(deps: V1Deps, status: StatusApiDeps): Hono<V1Env> {
  const app = new Hono<V1Env>();
  const read = requireKey(deps, { scope: ApiScopes.statusRead, kinds: [ApiKeyKinds.secret] });
  const write = requireKey(deps, { scope: ApiScopes.statusWrite, kinds: [ApiKeyKinds.secret] });

  // ── Locations and monitors ──────────────────────────────────────────────────────────────
  app.get('/locations', read, async c => {
    const locations = await status.locations.list(c.var.principal.workspaceId);
    return answer(c, statusV1LocationListSchema, { locations: locations.map(location => locationOf(location)) });
  });

  app.get('/monitors', read, async c => {
    const monitors = await status.monitors.list(scopeOf(c.var.principal));
    return answer(c, statusV1MonitorListSchema, { monitors: monitors.map(monitor => monitorOf(monitor)) });
  });

  app.get('/monitors/:monitorId', read, async c => {
    const id = pathId(c, 'monitorId');
    if (id === undefined) {
      return notFound('No such monitor');
    }
    return await mapped(async () =>
      answer(c, statusV1MonitorSchema, monitorOf(await status.monitors.find(scopeOf(c.var.principal), id))),
    );
  });

  // Create or change the monitor with this key; the same body again changes nothing.
  app.put('/monitors/by-key/:key', write, async c => {
    const key = statusMonitorKeySchema.safeParse(c.req.param('key'));
    if (!key.success) {
      return problemResponse(
        problemOf(
          400,
          ProblemCodes.badRequest,
          'Invalid request',
          'key: lowercase letters, digits, and inner dots, underscores and hyphens, at most 100',
        ),
      );
    }
    const body = await parseJson(c, monitorInputSchema);
    if (body.refused !== undefined) {
      return body.refused;
    }
    return await mapped(async () => {
      const { principal } = c.var;
      const result = await status.monitors.upsertByKey(scopeOf(principal), actorFor(principal), key.data, body.data);
      return answer(
        c,
        statusV1MonitorUpsertResultSchema,
        { outcome: result.outcome, monitor: monitorOf(result.monitor), heartbeatToken: result.heartbeatToken },
        result.outcome === MonitorUpsertOutcomes.created ? 201 : 200,
      );
    });
  });

  /** Pause or resume the monitor, then answer it as it is now. */
  const changeState = (change: 'pause' | 'resume') => async (c: Context<V1Env>) => {
    const id = pathId(c, 'monitorId');
    if (id === undefined) {
      return notFound('No such monitor');
    }
    return await mapped(async () => {
      const { principal } = c.var;
      await status.monitors[change](scopeOf(principal), actorFor(principal), id);
      return answer(c, statusV1MonitorSchema, monitorOf(await status.monitors.find(scopeOf(principal), id)));
    });
  };
  app.post('/monitors/:monitorId/pause', write, changeState('pause'));
  app.post('/monitors/:monitorId/resume', write, changeState('resume'));

  app.delete('/monitors/:monitorId', write, async c => {
    const id = pathId(c, 'monitorId');
    if (id === undefined) {
      return notFound('No such monitor');
    }
    return await mapped(async () => {
      await status.monitors.delete(scopeOf(c.var.principal), actorFor(c.var.principal), id);
      return c.body(null, 204);
    });
  });

  // ── Pages and components ────────────────────────────────────────────────────────────────
  app.get('/pages', read, async c => {
    const pages = await status.pages.listPages(scopeOf(c.var.principal));
    return answer(c, statusV1PageListSchema, { pages: pages.map(page => pageOf(page)) });
  });

  app.get('/pages/:pageId/components', read, async c => {
    const id = pathId(c, 'pageId');
    if (id === undefined) {
      return notFound('No such page');
    }
    return await mapped(async () => {
      const { components } = await status.pages.getPage(scopeOf(c.var.principal), id);
      return answer(c, statusV1ComponentListSchema, {
        components: components.map(component => componentOf(component)),
      });
    });
  });

  // Set the status a component reports by hand; open incidents and maintenance still count.
  app.patch('/components/:componentId', write, async c => {
    const id = pathId(c, 'componentId');
    if (id === undefined) {
      return notFound('No such component');
    }
    const body = await parseJson(c, statusV1ComponentStatusInputSchema);
    if (body.refused !== undefined) {
      return body.refused;
    }
    return await mapped(async () => {
      const scope = scopeOf(c.var.principal);
      const updated = await status.pages.setComponentStatus(scope, actorFor(c.var.principal), id, body.data.status);
      const { components } = await status.pages.getPage(scope, updated.pageId);
      const shown = components.find(component => component.id === id);
      return shown === undefined
        ? notFound(`Status component ${id} was not found`)
        : answer(c, statusV1ComponentSchema, componentOf(shown));
    });
  });

  // ── Incidents ───────────────────────────────────────────────────────────────────────────
  app.get('/incidents', read, async c => {
    const query = statusV1IncidentListQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return invalidQuery(query.error);
    }
    return await mapped(async () => {
      const incidents = await status.incidents.list(scopeOf(c.var.principal), query.data.pageId, query.data.open);
      return answer(c, statusV1IncidentListSchema, { incidents: incidents.map(incident => incidentOf(incident)) });
    });
  });

  app.get('/incidents/:incidentId', read, async c => {
    const id = pathId(c, 'incidentId');
    if (id === undefined) {
      return notFound('No such incident');
    }
    return await mapped(async () =>
      answer(
        c,
        statusV1IncidentDetailSchema,
        incidentDetailOf(await status.incidents.get(scopeOf(c.var.principal), id)),
      ),
    );
  });

  app.post('/incidents', write, async c => {
    const body = await parseJson(c, incidentCreateInputSchema);
    if (body.refused !== undefined) {
      return body.refused;
    }
    return await mapped(async () => {
      const scope = scopeOf(c.var.principal);
      const incident = await status.incidents.create(scope, actorFor(c.var.principal), body.data);
      return answer(
        c,
        statusV1IncidentDetailSchema,
        incidentDetailOf(await status.incidents.get(scope, incident.id)),
        201,
      );
    });
  });

  app.post('/incidents/:incidentId/updates', write, async c => {
    const id = pathId(c, 'incidentId');
    if (id === undefined) {
      return notFound('No such incident');
    }
    const body = await parseJson(c, incidentUpdateInputSchema);
    if (body.refused !== undefined) {
      return body.refused;
    }
    return await mapped(async () => {
      const { principal } = c.var;
      const result = await status.incidents.postUpdate(scopeOf(principal), actorFor(principal), id, body.data);
      return answer(
        c,
        statusV1IncidentUpdateResultSchema,
        { incident: incidentOf(result.incident), update: incidentUpdateOf(result.update) },
        201,
      );
    });
  });

  // Replace the components the incident affects, and how badly.
  app.put('/incidents/:incidentId/components', write, async c => {
    const id = pathId(c, 'incidentId');
    if (id === undefined) {
      return notFound('No such incident');
    }
    const body = await parseJson(c, statusV1IncidentComponentsInputSchema);
    if (body.refused !== undefined) {
      return body.refused;
    }
    return await mapped(async () => {
      const scope = scopeOf(c.var.principal);
      await status.incidents.setComponents(scope, actorFor(c.var.principal), id, body.data.components);
      return answer(c, statusV1IncidentDetailSchema, incidentDetailOf(await status.incidents.get(scope, id)));
    });
  });

  // ── Maintenance ─────────────────────────────────────────────────────────────────────────
  /** The page's window with this id, with its components, as the list reads it. */
  const maintenanceAnswer = async (c: Context<V1Env>, pageId: string, id: string, code: 200 | 201) => {
    const windows = await status.maintenances.list(scopeOf(c.var.principal), pageId);
    const window = windows.find(candidate => candidate.id === id);
    return window === undefined
      ? notFound(`Status maintenance ${id} was not found`)
      : answer(c, statusV1MaintenanceSchema, maintenanceOf(window), code);
  };

  app.get('/maintenances', read, async c => {
    const query = statusV1PageQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return invalidQuery(query.error);
    }
    return await mapped(async () => {
      const windows = await status.maintenances.list(scopeOf(c.var.principal), query.data.pageId);
      return answer(c, statusV1MaintenanceListSchema, {
        maintenances: windows.map(window => maintenanceOf(window)),
      });
    });
  });

  app.post('/maintenances', write, async c => {
    const body = await parseJson(c, statusV1MaintenanceInputSchema);
    if (body.refused !== undefined) {
      return body.refused;
    }
    return await mapped(async () => {
      const scheduled = await status.maintenances.schedule(
        scopeOf(c.var.principal),
        actorFor(c.var.principal),
        body.data,
      );
      return await maintenanceAnswer(c, scheduled.pageId, scheduled.id, 201);
    });
  });

  app.post('/maintenances/:maintenanceId/cancel', write, async c => {
    const id = pathId(c, 'maintenanceId');
    if (id === undefined) {
      return notFound('No such maintenance window');
    }
    return await mapped(async () => {
      const canceled = await status.maintenances.cancel(scopeOf(c.var.principal), actorFor(c.var.principal), id);
      return await maintenanceAnswer(c, canceled.pageId, canceled.id, 200);
    });
  });

  return app;
}
