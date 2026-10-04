// Status page (#103, slice #148): a project's status pages, their components, incidents and
// scheduled maintenance, managed by hand. Monitors, subscribers, the public snapshot and deploy
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
