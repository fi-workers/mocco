// Location health (#151, status page spec "Probe agent"): a location whose probe stops polling is
// silent. The `status.evaluate` job runs `sweep` every minute. A location in use (an unpaused
// monitor runs there) that hasn't leased or heartbeat for `ProbeProtocol.silentAfterSeconds` gets
// `unhealthy_since`, and rounds stop waiting for it (VerdictEvaluator): its missing results are
// `no_data`, which never counts either way, so the other locations decide. When it polls again
// the mark is cleared at the next sweep.
//
// Each transition alerts once. A private location's alert is a workspace event
// (`status.location.unhealthy`, `status.location.recovered`) for the notification rules to route;
// a shared location (a hosted region, the embedded probe) is Mocco's own, so its alert is an
// error log line for the operator's log alerting, never a customer's notification.
import { StatusEventTypes } from '@mocco/common/events';
import { Severities } from '@mocco/common/notification';
import { ProbeProtocol } from '@mocco/common/status';

import { publishBestEffort } from '@backend/domain/events/ports';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';

import type { PublishInput } from '@backend/domain/events/EventBus';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { LocationRow } from '@backend/domain/status/repos/location.repo';
import type { Db } from '@backend/infra/db/types';

export interface LocationHealthDeps {
  db: Db;
  /** Where a private location's alerts are published; without it there are none. */
  events?: EventPublisher;
  /** Where a shared location's alerts go; `console.error` by default. */
  log?: (message: string, details: Record<string, unknown>) => void;
}

const HealthChanges = { silent: 'silent', back: 'back' } as const;
type HealthChange = (typeof HealthChanges)[keyof typeof HealthChanges];

/** A private location's alert, deduplicated on the location and the moment it went silent. It has
 * no link: locations belong to the workspace, and the console shows them under each project. */
function alertInput(location: LocationRow & { workspaceId: string }, change: HealthChange, since: Date): PublishInput {
  const isSilent = change === HealthChanges.silent;
  const type = isSilent ? StatusEventTypes.statusLocationUnhealthy : StatusEventTypes.statusLocationRecovered;
  const lastSeen = location.lastSeenAt?.toISOString() ?? 'never';
  return {
    type,
    workspaceId: location.workspaceId,
    subject: { type: 'status_location', id: location.id },
    dedupeKey: `${type}:${location.id}:${since.toISOString()}`,
    payload: {
      facts: { location: location.code },
      message: {
        title: `${isSilent ? 'Location silent' : 'Location back'}: ${location.name}`.slice(0, 256),
        description: isSilent
          ? `The probe at ${location.code} last polled Mocco at ${lastSeen}. Its monitors' rounds count it as no data, so the other locations decide them. Check that the probe is running and can reach Mocco over HTTPS.`
          : `The probe at ${location.code} is polling Mocco again, and its monitors' rounds wait for it.`,
        severity: isSilent ? Severities.warning : Severities.success,
        fields: [{ name: 'Last seen', value: lastSeen, inline: true }],
        footer: 'Mocco status',
      },
    },
  };
}

export class LocationHealthService {
  constructor(private readonly deps: LocationHealthDeps) {}

  private async alert(location: LocationRow, change: HealthChange, since: Date): Promise<void> {
    const { workspaceId } = location;
    if (workspaceId === null) {
      const log = this.deps.log ?? ((message, details) => console.error(message, details));
      log(`[status] shared location ${change === HealthChanges.silent ? 'silent' : 'back'}`, {
        locationId: location.id,
        code: location.code,
        kind: location.kind,
        lastSeenAt: location.lastSeenAt?.toISOString() ?? null,
        silentSince: since.toISOString(),
      });
      return;
    }
    const { events } = this.deps;
    if (events !== undefined) {
      const input = alertInput({ ...location, workspaceId }, change, since);
      await publishBestEffort(events, input.type, async () => await Promise.resolve(input));
    }
  }

  /** Mark the locations that went silent and clear the ones that came back, alerting once for each. */
  async sweep(now: Date): Promise<{ silent: number; back: number }> {
    const locations = new LocationRepo(this.deps.db);
    const cutoff = new Date(now.getTime() - ProbeProtocol.silentAfterSeconds * 1000);
    const back = await locations.listHeardSince(cutoff);
    await locations.clearSilent(back.map(location => location.id));
    const silent = await locations.markSilent(cutoff, now);
    // One at a time, in a stable order, so the alerts read in the order they were found.
    await [
      ...back.map(location => ({ location, change: HealthChanges.back, since: location.unhealthySince ?? now })),
      ...silent.map(location => ({ location, change: HealthChanges.silent, since: now })),
    ].reduce(async (previous, entry) => {
      await previous;
      await this.alert(entry.location, entry.change, entry.since);
    }, Promise.resolve());
    return { silent: silent.length, back: back.length };
  }
}
