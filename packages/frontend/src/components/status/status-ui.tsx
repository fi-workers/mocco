// Labels and badges shared by the status page screens (#148).
import {
  ComponentImpacts,
  ComponentStatuses,
  IncidentSeverities,
  IncidentStatuses,
  MaintenanceStatuses,
} from '@mocco/common/status';

import { StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';

import type { Tone } from '@frontend/components/notifications/notification-ui';
import type { AppRouter } from '@mocco/backend/trpc/root';
import type {
  ComponentImpact,
  ComponentStatus,
  IncidentSeverity,
  IncidentStatus,
  MaintenanceStatus,
} from '@mocco/common/status';
import type { inferRouterOutputs } from '@trpc/server';

/** What the status router returns, per procedure. */
export type StatusOutputs = inferRouterOutputs<AppRouter>['status'];

/** The views of a status page in the console (`?tab=`). */
export const StatusTabs = { components: 'components', incidents: 'incidents', maintenance: 'maintenance' } as const;
export type StatusTab = (typeof StatusTabs)[keyof typeof StatusTabs];

/** Which incidents the incidents view lists (`?filter=`). */
export const IncidentFilters = { open: 'open', resolved: 'resolved' } as const;
export type IncidentFilter = (typeof IncidentFilters)[keyof typeof IncidentFilters];

export const componentStatusLabels: Readonly<Record<ComponentStatus, string>> = {
  [ComponentStatuses.operational]: 'Operational',
  [ComponentStatuses.maintenance]: 'Under maintenance',
  [ComponentStatuses.degraded]: 'Degraded performance',
  [ComponentStatuses.partialOutage]: 'Partial outage',
  [ComponentStatuses.majorOutage]: 'Major outage',
};

const componentStatusTones: Readonly<Record<ComponentStatus, Tone>> = {
  [ComponentStatuses.operational]: Tones.ok,
  [ComponentStatuses.maintenance]: Tones.neutral,
  [ComponentStatuses.degraded]: Tones.warn,
  [ComponentStatuses.partialOutage]: Tones.warn,
  [ComponentStatuses.majorOutage]: Tones.danger,
};

/** The status a component shows, as a badge. */
export function ComponentStatusBadge({ status }: { status: ComponentStatus }) {
  return <StatusBadge tone={componentStatusTones[status]}>{componentStatusLabels[status]}</StatusBadge>;
}

/** A status page slug suggested from its title: lowercase words joined by hyphens, at most 40 characters. */
export function slugFromTitle(title: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- title is a string, never null
  const words = title
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^a-z0-9]/u)
    .filter(word => word !== '');
  return words.reduce((slug, word) => {
    const next = slug === '' ? word : `${slug}-${word}`;
    return next.length > 40 ? slug : next;
  }, '');
}

export const componentImpactLabels: Readonly<Record<ComponentImpact, string>> = {
  [ComponentImpacts.degraded]: 'Degraded performance',
  [ComponentImpacts.partialOutage]: 'Partial outage',
  [ComponentImpacts.majorOutage]: 'Major outage',
};

export const incidentStatusLabels: Readonly<Record<IncidentStatus, string>> = {
  [IncidentStatuses.investigating]: 'Investigating',
  [IncidentStatuses.identified]: 'Identified',
  [IncidentStatuses.monitoring]: 'Monitoring',
  [IncidentStatuses.resolved]: 'Resolved',
};

const incidentStatusTones: Readonly<Record<IncidentStatus, Tone>> = {
  [IncidentStatuses.investigating]: Tones.danger,
  [IncidentStatuses.identified]: Tones.warn,
  [IncidentStatuses.monitoring]: Tones.warn,
  [IncidentStatuses.resolved]: Tones.ok,
};

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return <StatusBadge tone={incidentStatusTones[status]}>{incidentStatusLabels[status]}</StatusBadge>;
}

export const incidentSeverityLabels: Readonly<Record<IncidentSeverity, string>> = {
  [IncidentSeverities.minor]: 'Minor',
  [IncidentSeverities.major]: 'Major',
  [IncidentSeverities.critical]: 'Critical',
};

const maintenanceStatusLabels: Readonly<Record<MaintenanceStatus, string>> = {
  [MaintenanceStatuses.scheduled]: 'Scheduled',
  [MaintenanceStatuses.inProgress]: 'In progress',
  [MaintenanceStatuses.completed]: 'Completed',
  [MaintenanceStatuses.canceled]: 'Canceled',
};

const maintenanceStatusTones: Readonly<Record<MaintenanceStatus, Tone>> = {
  [MaintenanceStatuses.scheduled]: Tones.neutral,
  [MaintenanceStatuses.inProgress]: Tones.warn,
  [MaintenanceStatuses.completed]: Tones.ok,
  [MaintenanceStatuses.canceled]: Tones.neutral,
};

export function MaintenanceStatusBadge({ status }: { status: MaintenanceStatus }) {
  return <StatusBadge tone={maintenanceStatusTones[status]}>{maintenanceStatusLabels[status]}</StatusBadge>;
}

/** A date and time in the viewer's locale, e.g. "Oct 5, 2026, 14:30". */
export function formatWhen(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
