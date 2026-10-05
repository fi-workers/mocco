// The OpenAPI 3.1 description of the /v1 status management API (#159), served at
// `GET /v1/status/openapi.json` without a key. It is generated from the same
// `@mocco/common/status-v1` and `@mocco/common/status` schemas the routes parse with, and
// status-openapi.test.ts checks that it lists exactly the routes status.ts mounts, so it can't
// describe an API that isn't there.
import { ApiScopes } from '@mocco/common/apikey';
import { incidentCreateInputSchema, incidentUpdateInputSchema, monitorInputSchema } from '@mocco/common/status';
import {
  STATUS_MONITOR_KEY_PATTERN,
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

import { limitAnonymous } from '@backend/transport/ext/v1/middleware';
import { PROBLEM_CONTENT_TYPE } from '@backend/transport/ext/v1/problem';

import type { V1Deps } from '@backend/transport/ext/v1/middleware';
import type { ApiScope } from '@mocco/common/apikey';

type Method = 'get' | 'put' | 'post' | 'patch' | 'delete';

interface Operation {
  method: Method;
  /** OpenAPI's form: `{monitorId}`. */
  path: string;
  operationId: string;
  summary: string;
  scope: ApiScope;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** The success status and its body; none for 204. */
  ok: { status: 200 | 201 | 202 | 204; schema?: z.ZodType; also?: { status: 200 | 201; description: string } };
  /** Error statuses beyond the ones every operation has (401, 403, 429). */
  errors: readonly (400 | 404 | 409)[];
}

const read = ApiScopes.statusRead;
const write = ApiScopes.statusWrite;

/** Every status management operation, in the order the reference lists them. */
export const STATUS_OPERATIONS: readonly Operation[] = [
  {
    method: 'get',
    path: '/locations',
    operationId: 'listLocations',
    summary: "The locations the project's monitors may run at: Mocco's hosted regions and the workspace's own",
    scope: read,
    ok: { status: 200, schema: statusV1LocationListSchema },
    errors: [],
  },
  {
    method: 'get',
    path: '/monitors',
    operationId: 'listMonitors',
    summary: "The project's monitors",
    scope: read,
    ok: { status: 200, schema: statusV1MonitorListSchema },
    errors: [],
  },
  {
    method: 'get',
    path: '/monitors/{monitorId}',
    operationId: 'getMonitor',
    summary: 'One monitor',
    scope: read,
    ok: { status: 200, schema: statusV1MonitorSchema },
    errors: [404],
  },
  {
    method: 'put',
    path: '/monitors/by-key/{key}',
    operationId: 'upsertMonitor',
    summary:
      'Create the monitor with this key, or change it to match; the same body again changes nothing (outcome `unchanged`)',
    scope: write,
    body: monitorInputSchema,
    ok: {
      status: 201,
      schema: statusV1MonitorUpsertResultSchema,
      also: { status: 200, description: 'The monitor existed: `updated` or `unchanged`' },
    },
    errors: [400, 404, 409],
  },
  {
    method: 'post',
    path: '/monitors/{monitorId}/pause',
    operationId: 'pauseMonitor',
    summary: 'Stop checking the monitor',
    scope: write,
    ok: { status: 200, schema: statusV1MonitorSchema },
    errors: [404],
  },
  {
    method: 'post',
    path: '/monitors/{monitorId}/resume',
    operationId: 'resumeMonitor',
    summary: 'Check the monitor again; it is `pending` until its next verdict',
    scope: write,
    ok: { status: 200, schema: statusV1MonitorSchema },
    errors: [404],
  },
  {
    method: 'post',
    path: '/monitors/{monitorId}/check',
    operationId: 'checkMonitor',
    summary: "Run the monitor's next round now, e.g. after a deploy",
    scope: write,
    ok: {
      status: 202,
      schema: z.object({ monitorId: z.uuid(), roundAt: z.iso.datetime() }),
    },
    errors: [404, 409],
  },
  {
    method: 'delete',
    path: '/monitors/{monitorId}',
    operationId: 'deleteMonitor',
    summary: 'Delete the monitor with its history',
    scope: write,
    ok: { status: 204 },
    errors: [404],
  },
  {
    method: 'get',
    path: '/pages',
    operationId: 'listPages',
    summary: "The project's status pages",
    scope: read,
    ok: { status: 200, schema: statusV1PageListSchema },
    errors: [],
  },
  {
    method: 'get',
    path: '/pages/{pageId}/components',
    operationId: 'listComponents',
    summary: "A page's components, each with the status it shows",
    scope: read,
    ok: { status: 200, schema: statusV1ComponentListSchema },
    errors: [404],
  },
  {
    method: 'patch',
    path: '/components/{componentId}',
    operationId: 'setComponentStatus',
    summary: 'Set the status a component reports by hand; open incidents and maintenance still count',
    scope: write,
    body: statusV1ComponentStatusInputSchema,
    ok: { status: 200, schema: statusV1ComponentSchema },
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/incidents',
    operationId: 'listIncidents',
    summary: "A page's incidents, newest first, drafts included",
    scope: read,
    query: statusV1IncidentListQuerySchema,
    ok: { status: 200, schema: statusV1IncidentListSchema },
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/incidents/{incidentId}',
    operationId: 'getIncident',
    summary: 'One incident with its timeline and the components it affects',
    scope: read,
    ok: { status: 200, schema: statusV1IncidentDetailSchema },
    errors: [404],
  },
  {
    method: 'post',
    path: '/incidents',
    operationId: 'createIncident',
    summary: 'Open a published incident with its first update',
    scope: write,
    body: incidentCreateInputSchema,
    ok: { status: 201, schema: statusV1IncidentDetailSchema },
    errors: [400, 404],
  },
  {
    method: 'post',
    path: '/incidents/{incidentId}/updates',
    operationId: 'postIncidentUpdate',
    summary: "Post an update, moving the incident's status forward (or back from monitoring to identified)",
    scope: write,
    body: incidentUpdateInputSchema,
    ok: { status: 201, schema: statusV1IncidentUpdateResultSchema },
    errors: [400, 404, 409],
  },
  {
    method: 'put',
    path: '/incidents/{incidentId}/components',
    operationId: 'setIncidentComponents',
    summary: 'Replace the components the incident affects, and how badly',
    scope: write,
    body: statusV1IncidentComponentsInputSchema,
    ok: { status: 200, schema: statusV1IncidentDetailSchema },
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/maintenances',
    operationId: 'listMaintenances',
    summary: "A page's maintenance windows, latest start first",
    scope: read,
    query: statusV1PageQuerySchema,
    ok: { status: 200, schema: statusV1MaintenanceListSchema },
    errors: [400, 404],
  },
  {
    method: 'post',
    path: '/maintenances',
    operationId: 'scheduleMaintenance',
    summary: 'Schedule a maintenance window; Mocco starts and completes it on time',
    scope: write,
    body: statusV1MaintenanceInputSchema,
    ok: { status: 201, schema: statusV1MaintenanceSchema },
    errors: [400, 404],
  },
  {
    method: 'post',
    path: '/maintenances/{maintenanceId}/cancel',
    operationId: 'cancelMaintenance',
    summary: 'Cancel a window that has not completed; one in progress ends now',
    scope: write,
    ok: { status: 200, schema: statusV1MaintenanceSchema },
    errors: [404, 409],
  },
];

const problemRef = { $ref: '#/components/schemas/Problem' };
const errorDescriptions: Record<400 | 401 | 403 | 404 | 409 | 429, string> = {
  400: 'The body or query is invalid (`bad_request`)',
  401: 'No key, or an unknown, revoked or expired one',
  403: 'Not a secret key (`wrong_key_kind`), or it lacks the scope (`insufficient_scope`)',
  404: "Unknown, or another project's",
  409: "The change isn't possible in the current state (`conflict`)",
  429: 'Over the rate limit (`rate_limited`); see `Retry-After`',
};

/** A JSON Schema without the `$schema` key zod adds (OpenAPI 3.1 documents carry their own dialect). */
function jsonSchemaOf(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(z.toJSONSchema(schema, { io, unrepresentable: 'any' })).filter(([key]) => key !== '$schema'),
  );
}

const pathParams = (path: string) =>
  // eslint-disable-next-line sonarjs/null-dereference -- `path` is a string literal of STATUS_OPERATIONS
  (path.match(/(?<=\{)\w+(?=\})/gu) ?? []).map(name => ({
    name,
    in: 'path',
    required: true,
    schema:
      name === 'key'
        ? { type: 'string', pattern: STATUS_MONITOR_KEY_PATTERN.source, maxLength: 100 }
        : { type: 'string', format: 'uuid' },
  }));

function queryParams(query: z.ZodObject | undefined) {
  if (query === undefined) {
    return [];
  }
  const schema = jsonSchemaOf(query, 'input') as { properties?: Record<string, unknown>; required?: string[] };
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    in: 'query',
    required: schema.required?.includes(name) ?? false,
    schema: property,
  }));
}

const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });

function operationOf(operation: Operation) {
  const success = {
    [operation.ok.status]: {
      description: operation.ok.status === 204 ? 'Done' : 'OK',
      ...(operation.ok.schema !== undefined && { content: json(jsonSchemaOf(operation.ok.schema, 'output')) }),
    },
    ...(operation.ok.also !== undefined &&
      operation.ok.schema !== undefined && {
        [operation.ok.also.status]: {
          description: operation.ok.also.description,
          content: json(jsonSchemaOf(operation.ok.schema, 'output')),
        },
      }),
  };
  const errors = Object.fromEntries(
    ([...operation.errors, 401, 403, 429] as const).map(status => [
      status,
      { description: errorDescriptions[status], content: { [PROBLEM_CONTENT_TYPE]: { schema: problemRef } } },
    ]),
  );
  const parameters = [...pathParams(operation.path), ...queryParams(operation.query)];
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    security: [{ apiKey: [] }],
    'x-mocco-scope': operation.scope,
    ...(parameters.length > 0 && { parameters }),
    ...(operation.body !== undefined && {
      requestBody: { required: true, content: json(jsonSchemaOf(operation.body, 'input')) },
    }),
    responses: { ...success, ...errors },
  };
}

/** The OpenAPI document. `serverUrl` is the API's base, e.g. `https://www.mocco.work/api/ext/v1`. */
export function statusOpenApiDocument(serverUrl: string) {
  const paths = STATUS_OPERATIONS.reduce<Record<string, Record<string, unknown>>>(
    (described, operation) => ({
      ...described,
      [operation.path]: { ...described[operation.path], [operation.method]: operationOf(operation) },
    }),
    {},
  );
  return {
    openapi: '3.1.0',
    info: {
      title: 'Mocco status API',
      version: 'v1',
      description:
        "Monitors, incidents, maintenance and components of one project, for CI and scripts. Every call takes a secret API key of the project (`Authorization: Bearer mk_sec_…`); reads need `status:read` and changes `status:write`. Another project's resources answer 404.",
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'A secret project API key' } },
      schemas: {
        Problem: {
          type: 'object',
          description: 'RFC 9457 problem details',
          required: ['type', 'title', 'status'],
          properties: {
            type: { type: 'string', format: 'uri' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
          },
        },
      },
    },
    paths,
  };
}

export function createStatusOpenApiRoutes(deps: V1Deps): Hono {
  const app = new Hono();
  // The document is the same for everyone; its server is the base the request came in on.
  app.get('/openapi.json', limitAnonymous(deps), c => {
    const base = new URL(c.req.url);
    const serverUrl = `${base.origin}${base.pathname.replace(/\/status\/openapi\.json$/u, '')}`;
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(statusOpenApiDocument(serverUrl));
  });
  return app;
}
