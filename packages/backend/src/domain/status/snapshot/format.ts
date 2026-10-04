// The public snapshot of a status page (ADR 0028): what `snapshot.json` holds and what the
// static page and feed are rendered from. It is the egress boundary of the public page, so it
// lists every field a visitor may see; nothing else is published.
import {
  componentImpactSchema,
  componentStatusSchema,
  incidentSeveritySchema,
  incidentStatusSchema,
  MaintenanceStatuses,
} from '@mocco/common/status';
import { z } from 'zod';

const time = z.iso.datetime();

const publicComponentSchema = z.object({
  /** The component's id: the only internal id a snapshot carries. */
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  status: componentStatusSchema,
  /** The 90-day uptime bars. Null until daily rollups exist: the page shows "no data". */
  uptime: z.null(),
});

const publicIncidentSchema = z.object({
  /** A stable public key derived from the incident (not its database id). */
  key: z.string(),
  title: z.string(),
  status: incidentStatusSchema,
  severity: incidentSeveritySchema,
  startedAt: time,
  resolvedAt: time.nullable(),
  components: z.array(z.object({ id: z.uuid(), name: z.string(), impact: componentImpactSchema })),
  /** Newest first. */
  updates: z.array(z.object({ status: incidentStatusSchema, body: z.string(), at: time })),
});

const publicMaintenanceSchema = z.object({
  title: z.string(),
  body: z.string(),
  status: z.enum([MaintenanceStatuses.scheduled, MaintenanceStatuses.inProgress]),
  scheduledStart: time,
  scheduledEnd: time,
  components: z.array(z.object({ id: z.uuid(), name: z.string() })),
});

export const publicSnapshotSchema = z.object({
  format: z.literal(1),
  version: z.int().positive(),
  builtAt: time,
  page: z.object({ slug: z.string(), title: z.string() }),
  /** The worst status any component shows. */
  status: componentStatusSchema,
  /** Ungrouped components first (name null), then each group in order. */
  sections: z.array(z.object({ name: z.string().nullable(), components: z.array(publicComponentSchema) })),
  /** Open incidents, newest first. */
  incidents: z.array(publicIncidentSchema),
  /** Maintenance in progress or scheduled, soonest first. */
  maintenances: z.array(publicMaintenanceSchema),
  /** The latest resolved incidents, most recently resolved first. */
  history: z.array(publicIncidentSchema),
});
export type PublicSnapshot = z.infer<typeof publicSnapshotSchema>;
export type PublicIncident = z.infer<typeof publicIncidentSchema>;

/** What `current.json` holds: the live version and the etag of its snapshot. */
export interface SnapshotPointer {
  version: number;
  etag: string;
  builtAt: string;
}
