// Status page (#103): a project's status pages, their components, incidents and scheduled
// maintenance (#148), and its monitors and probe locations (#150). Subscribers and deploy
// correlation come in later slices (docs/specs/2026-09-24-status-page-design.md).
import { z } from 'zod';

/** What a component shows. The DB checks on `mocco_status_components.status` use this object. */
export const ComponentStatuses = {
  operational: 'operational',
  maintenance: 'maintenance',
  degraded: 'degraded',
  partialOutage: 'partial_outage',
  majorOutage: 'major_outage',
} as const;
export type ComponentStatus = (typeof ComponentStatuses)[keyof typeof ComponentStatuses];
export const componentStatusSchema = z.enum(
  Object.values(ComponentStatuses) as [ComponentStatus, ...ComponentStatus[]],
);

/** How badly an incident affects a component. */
export const ComponentImpacts = {
  degraded: ComponentStatuses.degraded,
  partialOutage: ComponentStatuses.partialOutage,
  majorOutage: ComponentStatuses.majorOutage,
} as const;
export type ComponentImpact = (typeof ComponentImpacts)[keyof typeof ComponentImpacts];
export const componentImpactSchema = z.enum(Object.values(ComponentImpacts) as [ComponentImpact, ...ComponentImpact[]]);

/** Worse statuses rank higher: an incident's impact outranks maintenance, maintenance outranks operational. */
export const COMPONENT_STATUS_RANK: Record<ComponentStatus, number> = {
  [ComponentStatuses.operational]: 0,
  [ComponentStatuses.maintenance]: 1,
  [ComponentStatuses.degraded]: 2,
  [ComponentStatuses.partialOutage]: 3,
  [ComponentStatuses.majorOutage]: 4,
};

export const IncidentStatuses = {
  investigating: 'investigating',
  identified: 'identified',
  monitoring: 'monitoring',
  resolved: 'resolved',
} as const;
export type IncidentStatus = (typeof IncidentStatuses)[keyof typeof IncidentStatuses];
export const incidentStatusSchema = z.enum(Object.values(IncidentStatuses) as [IncidentStatus, ...IncidentStatus[]]);

/**
 * The status changes an update may make. An incident moves forward (skipping is fine), may go
 * back from monitoring to identified when a fix doesn't hold, and is closed once resolved. An
 * update that keeps the status is always allowed while the incident is open.
 */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  [IncidentStatuses.investigating]: [
    IncidentStatuses.identified,
    IncidentStatuses.monitoring,
    IncidentStatuses.resolved,
  ],
  [IncidentStatuses.identified]: [IncidentStatuses.monitoring, IncidentStatuses.resolved],
  [IncidentStatuses.monitoring]: [IncidentStatuses.identified, IncidentStatuses.resolved],
  [IncidentStatuses.resolved]: [],
};

/**
 * Whether an incident is on the public page. Incidents an operator opens are published; a draft
 * (monitor-origin incidents, later) stays in the console and never reaches the public snapshot.
 */
export const IncidentVisibilities = { draft: 'draft', published: 'published' } as const;
export type IncidentVisibility = (typeof IncidentVisibilities)[keyof typeof IncidentVisibilities];

export const IncidentSeverities = { minor: 'minor', major: 'major', critical: 'critical' } as const;
export type IncidentSeverity = (typeof IncidentSeverities)[keyof typeof IncidentSeverities];
export const incidentSeveritySchema = z.enum(
  Object.values(IncidentSeverities) as [IncidentSeverity, ...IncidentSeverity[]],
);

/** A maintenance window's lifecycle: the maintenance tick starts and completes it; an operator may cancel it. */
export const MaintenanceStatuses = {
  scheduled: 'scheduled',
  inProgress: 'in_progress',
  completed: 'completed',
  canceled: 'canceled',
} as const;
export type MaintenanceStatus = (typeof MaintenanceStatuses)[keyof typeof MaintenanceStatuses];

/** A status page slug: lowercase alphanumerics and inner hyphens, 1–40 chars. Mirrors the DB CHECK. */
export const STATUS_PAGE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const StatusLimits = { nameMax: 120, descriptionMax: 500, bodyMax: 20_000, postmortemMax: 100_000 } as const;

const name = z.string().trim().min(1).max(StatusLimits.nameMax);
const body = z.string().trim().min(1).max(StatusLimits.bodyMax);

export const statusPageInputSchema = z.object({ slug: z.string().regex(STATUS_PAGE_SLUG_PATTERN), title: name });
export type StatusPageInput = z.infer<typeof statusPageInputSchema>;

export const componentGroupInputSchema = z.object({ name, position: z.int().min(0).optional() });
export type ComponentGroupInput = z.infer<typeof componentGroupInputSchema>;

export const componentInputSchema = z.object({
  name,
  description: z.string().trim().max(StatusLimits.descriptionMax).nullable().optional(),
  groupId: z.uuid().nullable().optional(),
  position: z.int().min(0).optional(),
});
export type ComponentInput = z.infer<typeof componentInputSchema>;

export const affectedComponentSchema = z.object({ componentId: z.uuid(), impact: componentImpactSchema });
export type AffectedComponent = z.infer<typeof affectedComponentSchema>;
export const affectedComponentsSchema = z.array(affectedComponentSchema).max(100);

export const incidentCreateInputSchema = z.object({
  pageId: z.uuid(),
  title: name,
  severity: incidentSeveritySchema,
  /** The first update's status; an incident can't be opened as resolved. */
  status: incidentStatusSchema.exclude([IncidentStatuses.resolved]).default(IncidentStatuses.investigating),
  body,
  components: affectedComponentsSchema.default([]),
});
export type IncidentCreateInput = z.infer<typeof incidentCreateInputSchema>;

export const incidentUpdateInputSchema = z.object({ status: incidentStatusSchema, body });
export type IncidentUpdateInput = z.infer<typeof incidentUpdateInputSchema>;

export const postmortemInputSchema = z.object({
  postmortem: z.string().trim().max(StatusLimits.postmortemMax).nullable(),
});

export const maintenanceInputSchema = z
  .object({
    pageId: z.uuid(),
    title: name,
    body: z.string().trim().max(StatusLimits.bodyMax).default(''),
    scheduledStart: z.date(),
    scheduledEnd: z.date(),
    componentIds: z.array(z.uuid()).max(100).default([]),
  })
  .refine(input => input.scheduledEnd > input.scheduledStart, {
    message: 'A maintenance window ends after it starts',
    path: ['scheduledEnd'],
  });
export type MaintenanceInput = z.infer<typeof maintenanceInputSchema>;

// ─────────────────────────────────────────────────────────────
// Monitors and probe locations (#150). A monitor is an HTTP or TCP check of a project, run
// by `@mocco/probe` agents at the locations it is assigned to (ADR 0027). A location is a
// hosted region (no workspace) or a workspace's private location, authenticated by its token.
// ─────────────────────────────────────────────────────────────

export const MonitorKinds = { http: 'http', tcp: 'tcp' } as const;
export type MonitorKind = (typeof MonitorKinds)[keyof typeof MonitorKinds];

/**
 * A monitor's state. `pending` until its first verdict; the evaluator moves it through
 * `up → suspect → down → recovering → up` (and `degraded` when latency fails by quorum);
 * only an operator pauses and resumes it.
 */
export const MonitorStates = {
  pending: 'pending',
  up: 'up',
  suspect: 'suspect',
  down: 'down',
  recovering: 'recovering',
  degraded: 'degraded',
  paused: 'paused',
} as const;
export type MonitorState = (typeof MonitorStates)[keyof typeof MonitorStates];

/** How many reporting locations must agree on a round: half or more, one, or every one. */
export const QuorumModes = { majority: 'majority', any: 'any', all: 'all' } as const;
export type QuorumMode = (typeof QuorumModes)[keyof typeof QuorumModes];
export const quorumModeSchema = z.enum(Object.values(QuorumModes) as [QuorumMode, ...QuorumMode[]]);

/** Where a probe runs: Mocco's hosted region, a workspace's own network, or in-process on a one-box install. */
export const LocationKinds = { hosted: 'hosted', private: 'private', embedded: 'embedded' } as const;
export type LocationKind = (typeof LocationKinds)[keyof typeof LocationKinds];

export const HttpMonitorMethods = { GET: 'GET', HEAD: 'HEAD', POST: 'POST' } as const;
export type HttpMonitorMethod = (typeof HttpMonitorMethods)[keyof typeof HttpMonitorMethods];

/** Whether the response body must contain the keyword or must not. */
export const KeywordModes = { contains: 'contains', absent: 'absent' } as const;
export type KeywordMode = (typeof KeywordModes)[keyof typeof KeywordModes];

export const MonitorLimits = {
  minIntervalSeconds: 60,
  maxIntervalSeconds: 86_400,
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  defaultConfirmations: 2,
  maxConfirmations: 10,
  maxLocations: 10,
  maxComponents: 50,
  urlMax: 2048,
  requestBodyMax: 10_000,
  keywordMax: 200,
} as const;

const timeoutMs = z.int().min(1000).max(MonitorLimits.maxTimeoutMs).default(MonitorLimits.defaultTimeoutMs);

export const httpMonitorSpecSchema = z.object({
  kind: z.literal(MonitorKinds.http),
  url: z.url({ protocol: /^https?$/ }).max(MonitorLimits.urlMax),
  method: z
    .enum(Object.values(HttpMonitorMethods) as [HttpMonitorMethod, ...HttpMonitorMethod[]])
    .default(HttpMonitorMethods.GET),
  body: z.string().max(MonitorLimits.requestBodyMax).optional(),
  /** The status codes that pass; empty means any 2xx. */
  expectedStatus: z.array(z.int().min(100).max(599)).max(20).default([]),
  keyword: z.string().min(1).max(MonitorLimits.keywordMax).optional(),
  keywordMode: z.enum(Object.values(KeywordModes) as [KeywordMode, ...KeywordMode[]]).default(KeywordModes.contains),
  /** A slower answer that otherwise passes makes the round `degraded`. */
  latencyThresholdMs: z.int().min(1).max(MonitorLimits.maxTimeoutMs).optional(),
  timeoutMs,
  followRedirects: z.boolean().default(true),
  /** Warn when the certificate expires within this many days. */
  tlsWarnDays: z.int().min(1).max(365).optional(),
});

export const tcpMonitorSpecSchema = z.object({
  kind: z.literal(MonitorKinds.tcp),
  host: z.string().trim().min(1).max(253),
  port: z.int().min(1).max(65_535),
  timeoutMs,
});

/** What a probe checks, by kind. Stored as the monitor's `spec` and sent to probes in their leases. */
export const monitorSpecSchema = z.discriminatedUnion('kind', [httpMonitorSpecSchema, tcpMonitorSpecSchema]);
export type MonitorSpec = z.infer<typeof monitorSpecSchema>;

export const monitorComponentSchema = z.object({ componentId: z.uuid(), impactWhenDown: componentImpactSchema });
export type MonitorComponent = z.infer<typeof monitorComponentSchema>;

const confirmations = z.int().min(1).max(MonitorLimits.maxConfirmations).default(MonitorLimits.defaultConfirmations);

export const monitorInputSchema = z.object({
  name,
  spec: monitorSpecSchema,
  intervalSeconds: z
    .int()
    .min(MonitorLimits.minIntervalSeconds)
    .max(MonitorLimits.maxIntervalSeconds)
    .default(MonitorLimits.minIntervalSeconds),
  /** Consecutive failing rounds before `down`. */
  confirmations,
  /** Consecutive passing rounds before `recovering` is `up` again. */
  recoveryConfirmations: confirmations,
  quorumMode: quorumModeSchema.default(QuorumModes.majority),
  locationIds: z.array(z.uuid()).min(1).max(MonitorLimits.maxLocations),
  /** The components this monitor reports on, and what they show while it is down. */
  components: z.array(monitorComponentSchema).max(MonitorLimits.maxComponents).default([]),
});
export type MonitorInput = z.infer<typeof monitorInputSchema>;

/** A location code: lowercase letters, digits and inner hyphens ("fra", "office-vpn"). */
export const LOCATION_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const locationInputSchema = z.object({ code: z.string().regex(LOCATION_CODE_PATTERN), name });
export type LocationInput = z.infer<typeof locationInputSchema>;

/** A location as the console sees it: never its token hash. */
export const locationSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid().nullable(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(Object.values(LocationKinds) as [LocationKind, ...LocationKind[]]),
  lastSeenAt: z.date().nullable(),
  agentVersion: z.string().nullable(),
  disabledAt: z.date().nullable(),
  createdAt: z.date(),
});
export type LocationDto = z.infer<typeof locationSchema>;

// ─────────────────────────────────────────────────────────────
// The probe protocol (ADR 0027): `@mocco/probe` agents lease the rounds due at their location,
// run them, and report one result per lease. `/api/ext/v1/probe/*`, location-token auth.
// ─────────────────────────────────────────────────────────────

/** What one location saw in one round. A probe reports `ok` or `fail`; `no_data` is what the
 * evaluator assumes for a lease nobody reported, and it never counts as downtime. */
export const CheckOutcomes = { ok: 'ok', fail: 'fail', noData: 'no_data' } as const;
export type CheckOutcome = (typeof CheckOutcomes)[keyof typeof CheckOutcomes];

/** Why a check failed (or, for `latency`, why it was slow). */
export const CheckErrorKinds = {
  timeout: 'timeout',
  dns: 'dns',
  connect: 'connect',
  tls: 'tls',
  status: 'status',
  keyword: 'keyword',
  latency: 'latency',
} as const;
export type CheckErrorKind = (typeof CheckErrorKinds)[keyof typeof CheckErrorKinds];

export const ProbeProtocol = {
  /** A lease call returns the rounds due within this many seconds. */
  leaseLookaheadSeconds: 60,
  /** A result is accepted until the round's time plus the check's timeout plus this grace. */
  resultGraceSeconds: 15,
  /** How long an agent waits before its next lease call. */
  pollAfterMs: 15_000,
  maxCapacity: 200,
  maxResults: 200,
  detailMax: 512,
} as const;

export const probeLeaseRequestSchema = z.object({
  agentVersion: z.string().trim().min(1).max(64),
  /** How many checks the agent will take in this call. */
  capacity: z.int().min(1).max(ProbeProtocol.maxCapacity).default(50),
});

export const probeResultSchema = z.object({
  leaseId: z.uuid(),
  monitorId: z.uuid(),
  roundAt: z.coerce.date(),
  outcome: z.enum([CheckOutcomes.ok, CheckOutcomes.fail]),
  errorKind: z.enum(Object.values(CheckErrorKinds) as [CheckErrorKind, ...CheckErrorKind[]]).optional(),
  statusCode: z.int().min(100).max(599).optional(),
  latencyMs: z.int().min(0).max(600_000).optional(),
  /** Phase timings in milliseconds (dns, connect, tls, ttfb). */
  timings: z.record(z.enum(['dns', 'connect', 'tls', 'ttfb']), z.number().min(0).max(600_000)).optional(),
  tlsExpiresAt: z.coerce.date().optional(),
  /** Truncated to 512 characters. */
  detail: z.string().optional(),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

export const probeResultsRequestSchema = z.object({
  results: z.array(probeResultSchema).min(1).max(ProbeProtocol.maxResults),
});

export const probeHeartbeatRequestSchema = z.object({
  agentVersion: z.string().trim().min(1).max(64),
  inflight: z.int().min(0).max(10_000).default(0),
});
