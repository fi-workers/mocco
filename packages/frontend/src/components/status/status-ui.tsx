// Labels and badges shared by the status page screens (#148).
import { ComponentStatuses } from '@mocco/common/status';

import { StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';

import type { Tone } from '@frontend/components/notifications/notification-ui';
import type { AppRouter } from '@mocco/backend/trpc/root';
import type { ComponentStatus } from '@mocco/common/status';
import type { inferRouterOutputs } from '@trpc/server';

/** What the status router returns, per procedure. */
export type StatusOutputs = inferRouterOutputs<AppRouter>['status'];

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
