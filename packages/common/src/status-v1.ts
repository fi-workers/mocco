// The /v1 status management wire shapes (#159): monitors (upserted by a caller-chosen key),
// incidents and their updates, maintenance windows, pages and their components, for CI and
// scripts with a secret key holding `status:read` or `status:write`. The routes parse their
// answers through these schemas, which drop any field they don't list, and the OpenAPI
// description is generated from them, so the three can't drift apart.
import { z } from 'zod';

import {
  IncidentOrigins,
  IncidentVisibilities,
  LocationKinds,
  MaintenanceStatuses,
  MonitorKinds,
  MonitorStates,
  affectedComponentsSchema,
  componentImpactSchema,
  componentStatusSchema,
  incidentPolicySchema,
  incidentSeveritySchema,
  incidentStatusSchema,
  maintenanceInputSchema,
  monitorComponentSchema,
  quorumModeSchema,
} from '@mocco/common/status';

/**
 * A monitor's key: the caller's own name for it (`api-health`), unique in the project, so
 * running the same upsert from CI again changes the monitor it made instead of adding one.
 * Lowercase letters, digits, and inner dots, underscores and hyphens, 1 to 100 characters.
 * Mirrors the DB check.
 */
export const STATUS_MONITOR_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
export const statusMonitorKeySchema = z.string().regex(STATUS_MONITOR_KEY_PATTERN);

/** What a monitor upsert did: made it, changed its settings, or found it already as asked. */
export const MonitorUpsertOutcomes = { created: 'created', updated: 'updated', unchanged: 'unchanged' } as const;
export type MonitorUpsertOutcome = (typeof MonitorUpsertOutcomes)[keyof typeof MonitorUpsertOutcomes];

const timestamp = z.iso.datetime();
const enumOf = <T extends string>(values: Record<string, T>) => z.enum(Object.values(values) as [T, ...T[]]);

/** A timestamp in a request body: ISO 8601 with an offset (`2026-10-06T09:00:00Z`). */
const requestTime = z.iso.datetime({ offset: true }).pipe(z.coerce.date());

export const statusV1LocationSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  kind: enumOf(LocationKinds),
  disabled: z.boolean(),
});

export const statusV1LocationListSchema = z.object({ locations: z.array(statusV1LocationSchema) });

/**
 * A monitor. What it checks is told only by `target` (an HTTP URL's host and port, or a TCP
 * host and port) and the settings in `check`: a URL's path, query and credentials and a
 * request body can hold secrets, so they never leave Mocco. A heartbeat's ping token is in
 * the upsert answer that creates it, and nowhere else.
 */
export const statusV1MonitorSchema = z.object({
  id: z.uuid(),
  /** Null for a monitor made in the console. */
  key: z.string().nullable(),
  name: z.string(),
  kind: enumOf(MonitorKinds),
  target: z.string().nullable(),
  state: enumOf(MonitorStates),
  stateChangedAt: timestamp,
  /** A probe check's settings; null for a heartbeat. */
  check: z
    .object({
      /** HTTP only, like the three after it; null for TCP. */
      method: z.string().nullable(),
      /** The status codes that pass; empty means any 2xx. */
      expectedStatus: z.array(z.int()),
      latencyThresholdMs: z.int().nullable(),
      timeoutMs: z.int(),
      followRedirects: z.boolean().nullable(),
      tlsWarnDays: z.int().nullable(),
    })
    .nullable(),
  /** A heartbeat's period, grace and last ping; null for a probe check. */
  heartbeat: z
    .object({
      periodSeconds: z.int(),
      graceSeconds: z.int(),
      lastPingAt: timestamp.nullable(),
      lastStartAt: timestamp.nullable(),
      lastDurationMs: z.int().nullable(),
    })
    .nullable(),
  intervalSeconds: z.int(),
  confirmations: z.int(),
  recoveryConfirmations: z.int(),
  quorumMode: quorumModeSchema,
  incidentPolicy: incidentPolicySchema,
  locationIds: z.array(z.uuid()),
  components: z.array(monitorComponentSchema),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type StatusV1Monitor = z.infer<typeof statusV1MonitorSchema>;

export const statusV1MonitorListSchema = z.object({ monitors: z.array(statusV1MonitorSchema) });

/** `PUT /v1/monitors/by-key/{key}`: 201 with `created`, else 200. */
export const statusV1MonitorUpsertResultSchema = z.object({
  outcome: enumOf(MonitorUpsertOutcomes),
  monitor: statusV1MonitorSchema,
  /** A new heartbeat's ping token (`mhb_…`), shown this once; null otherwise. */
  heartbeatToken: z.string().nullable(),
});

export const statusV1PageSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const statusV1PageListSchema = z.object({ pages: z.array(statusV1PageSchema) });

export const statusV1ComponentSchema = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  groupId: z.uuid().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  position: z.int(),
  /** The status set by hand (or through this API). */
  status: componentStatusSchema,
  /** What the page shows: the worst of `status`, open incidents, maintenance in progress and
   * the linked monitors. */
  displayedStatus: componentStatusSchema,
  updatedAt: timestamp,
});
export type StatusV1Component = z.infer<typeof statusV1ComponentSchema>;
export const statusV1ComponentListSchema = z.object({ components: z.array(statusV1ComponentSchema) });

export const statusV1ComponentStatusInputSchema = z.object({ status: componentStatusSchema });

export const statusV1IncidentSchema = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  title: z.string(),
  status: incidentStatusSchema,
  severity: incidentSeveritySchema,
  visibility: enumOf(IncidentVisibilities),
  origin: enumOf(IncidentOrigins),
  startedAt: timestamp,
  identifiedAt: timestamp.nullable(),
  resolvedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type StatusV1Incident = z.infer<typeof statusV1IncidentSchema>;
export const statusV1IncidentListSchema = z.object({ incidents: z.array(statusV1IncidentSchema) });

export const statusV1IncidentUpdateSchema = z.object({
  id: z.uuid(),
  status: incidentStatusSchema,
  /** Markdown. */
  body: z.string(),
  createdAt: timestamp,
});

export const statusV1AffectedComponentSchema = z.object({ componentId: z.uuid(), impact: componentImpactSchema });

/** One incident with its timeline (oldest first) and the components it affects. */
export const statusV1IncidentDetailSchema = z.object({
  incident: statusV1IncidentSchema,
  updates: z.array(statusV1IncidentUpdateSchema),
  components: z.array(statusV1AffectedComponentSchema),
});

export const statusV1IncidentUpdateResultSchema = z.object({
  incident: statusV1IncidentSchema,
  update: statusV1IncidentUpdateSchema,
});

export const statusV1IncidentComponentsInputSchema = z.object({ components: affectedComponentsSchema });

export const statusV1IncidentListQuerySchema = z.object({
  pageId: z.uuid(),
  /** `true`: leave out resolved incidents. */
  open: z
    .enum(['true', 'false'])
    .default('false')
    .transform(value => value === 'true'),
});

export const statusV1PageQuerySchema = z.object({ pageId: z.uuid() });

export const statusV1MaintenanceSchema = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  title: z.string(),
  /** Markdown. */
  body: z.string(),
  status: enumOf(MaintenanceStatuses),
  scheduledStart: timestamp,
  scheduledEnd: timestamp,
  actualStart: timestamp.nullable(),
  actualEnd: timestamp.nullable(),
  componentIds: z.array(z.uuid()),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type StatusV1Maintenance = z.infer<typeof statusV1MaintenanceSchema>;
export const statusV1MaintenanceListSchema = z.object({ maintenances: z.array(statusV1MaintenanceSchema) });

/** The console's maintenance input with its two times as ISO 8601 strings. */
export const statusV1MaintenanceInputSchema = z.object({
  ...maintenanceInputSchema.shape,
  scheduledStart: requestTime,
  scheduledEnd: requestTime,
});
