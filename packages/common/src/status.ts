// Status page (#103, slice #148): a project's status pages and the components they report on,
// managed by hand. Incidents and scheduled maintenance come next; monitors, subscribers, the
// public snapshot and deploy correlation come in later slices
// (docs/specs/2026-09-24-status-page-design.md).
import { z } from 'zod';

/** What a component shows. The DB check on `mocco_status_components.status` uses this object. */
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

/** A status page slug: lowercase alphanumerics and inner hyphens, 1–40 chars. Mirrors the DB CHECK. */
export const STATUS_PAGE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const StatusLimits = { nameMax: 120, descriptionMax: 500 } as const;

const name = z.string().trim().min(1).max(StatusLimits.nameMax);

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
