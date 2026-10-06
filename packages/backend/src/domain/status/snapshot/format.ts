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

/** Days in a component's uptime bars, ending today. */
export const UPTIME_BAR_DAYS = 90;

/** An uptime ratio as the percentage the page shows: two decimals, rounded down, so a day with
 * any downtime never shows 100%. Null stays null. */
export const uptimePercentOf = (ratio: number | null): number | null =>
  ratio === null ? null : Math.floor(ratio * 10_000) / 100;

const uptimeDaySchema = z.object({
  /** The UTC day, `YYYY-MM-DD`. */
  day: z.iso.date(),
  /** The worst status the component showed that day; null for a day with no data (before the
   * component existed, or not rolled up). */
  status: componentStatusSchema.nullable(),
  /** That day's uptime percentage (`uptimePercentOf`); null when it isn't measured (no monitor
   * reports on the component) or there is no data. */
  uptime: z.number().nullable(),
});

const publicComponentSchema = z.object({
  /** The component's id: the only internal id a snapshot carries. */
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  status: componentStatusSchema,
  /** The uptime bars: the last `UPTIME_BAR_DAYS` UTC days, oldest first, from the component days,
   * and the mean of the days' percentages (null when no day has one). */
  uptime: z.object({ days: z.array(uptimeDaySchema), percent: z.number().nullable() }),
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
  /** Where the page's sign-up form posts (#156); null when this deployment takes no email
   * sign-ups. Versions built before it existed read as null. */
  subscribe: z.object({ url: z.url() }).nullable().default(null),
});
export type PublicSnapshot = z.infer<typeof publicSnapshotSchema>;
export type PublicIncident = z.infer<typeof publicIncidentSchema>;
export type PublicUptimeDay = z.infer<typeof uptimeDaySchema>;

/** What `current.json` holds: the live version and the etag of its snapshot. */
export interface SnapshotPointer {
  version: number;
  etag: string;
  builtAt: string;
}
