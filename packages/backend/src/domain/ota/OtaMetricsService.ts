import { createHash } from 'node:crypto';

import { OtaEventTypes } from '@mocco/common/events';
import { Severities } from '@mocco/common/notification';
import { EMERGENCY_LAUNCH_ALERT } from '@mocco/common/ota-hosting';

import { publishBestEffort } from '@backend/domain/events/ports';

import type { EventPublisher } from '@backend/domain/events/ports';
import type { OtaAppRepo, OtaAppRow } from '@backend/domain/ota/repos/ota-app.repo';
import type { DeviceRow, OtaMetricsRepo } from '@backend/domain/ota/repos/ota-metrics.repo';
import type { OtaReleaseRepo } from '@backend/domain/ota/repos/ota-release.repo';
import type { ClientEventsRequest, OtaPlatform, ReleaseAdoptionDto } from '@mocco/common/ota-hosting';

/** One update check, as the manifest endpoint saw it. The client id never leaves memory unhashed. */
export interface DeviceSighting {
  appId: string;
  clientId: string;
  platform: OtaPlatform;
  runtimeVersion: string;
  channel: string;
  currentUpdateId: string | undefined;
  embeddedUpdateId: string | undefined;
}

export interface OtaMetricsServiceDeps {
  apps: Pick<OtaAppRepo, 'findById'>;
  metrics: OtaMetricsRepo;
  releases: Pick<OtaReleaseRepo, 'listOriginalUpdates' | 'findUpdate' | 'findById'>;
  /** Keeps a flush alive after the response (Vercel `waitUntil`); tests flush themselves. */
  waitUntil?: (promise: Promise<unknown>) => void;
  events?: EventPublisher;
  appOrigin?: string;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A device reporting the same update again within this is not written again. */
const SIGHTING_DEDUPE_MS = 10 * 60 * 1000;
const MAX_REMEMBERED_SIGHTINGS = 20_000;
const FLUSH_AT = 200;
const FLUSH_DELAY_MS = 1000;
export const METRICS_RETENTION_DAYS = 90;

const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** Sum `pick` over the rows about any of `ids`. */
function sumOf<T extends { updateId: string | null }>(
  rows: readonly T[],
  ids: readonly string[],
  pick: (row: T) => number,
): number {
  return rows
    .filter(row => row.updateId !== null && ids.includes(row.updateId))
    .reduce((sum, row) => sum + pick(row), 0);
}

/** The peppered hash a device is stored under: per app, so it can't be matched elsewhere. */
export const deviceHashOf = (pepper: string, clientId: string) =>
  createHash('sha256').update(`${pepper}:${clientId}`).digest('hex');

/**
 * Adoption metrics for Mocco-hosted OTA (OTA design §4.1, slice #133). Update checks feed
 * the device registry off the hot path: sightings are deduplicated in memory and written
 * in batches after the response. Apps report launches and emergency launches; an hourly
 * rollup counts adoption per update and day, and alerts on an emergency-launch spike.
 */
export class OtaMetricsService {
  private readonly now: () => Date;

  private buffer: DeviceSighting[] = [];

  private readonly seen = new Map<string, number>();

  private readonly apps = new Map<string, Pick<OtaAppRow, 'id' | 'workspaceId' | 'devicePepper'> | null>();

  private flushing: Promise<void> | null = null;

  constructor(private readonly deps: OtaMetricsServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async appOf(appId: string) {
    if (!this.apps.has(appId)) {
      this.apps.set(appId, (await this.deps.apps.findById(appId)) ?? null);
    }
    return this.apps.get(appId) ?? null;
  }

  private remember(key: string, at: number): boolean {
    const last = this.seen.get(key);
    if (last !== undefined && at - last < SIGHTING_DEDUPE_MS) {
      return false;
    }
    this.seen.delete(key);
    this.seen.set(key, at);
    if (this.seen.size > MAX_REMEMBERED_SIGHTINGS) {
      const oldest = this.seen.keys().next();
      if (oldest.done !== true) {
        this.seen.delete(oldest.value);
      }
    }
    return true;
  }

  private async alert(
    row: { workspaceId: string; appId: string; updateId: string; activeDevices: number; emergencyLaunches: number },
    day: string,
  ): Promise<void> {
    const { events } = this.deps;
    const update = await this.deps.releases.findUpdate(row.updateId);
    const release = update === undefined ? undefined : await this.deps.releases.findById(update.releaseId);
    const app = await this.appOf(row.appId);
    if (events === undefined || release === undefined || app === null) {
      return;
    }
    const full = await this.deps.apps.findById(app.id);
    const rate = row.activeDevices === 0 ? 1 : row.emergencyLaunches / row.activeDevices;
    await publishBestEffort(events, OtaEventTypes.otaEmergencyLaunchSpike, async () => ({
      type: OtaEventTypes.otaEmergencyLaunchSpike,
      workspaceId: row.workspaceId,
      ...(full !== undefined && { projectId: full.projectId }),
      subject: { type: 'ota_update', id: row.updateId },
      // One alert per update and day.
      dedupeKey: `ota.emergency_launch.spike:${row.updateId}:${day}`,
      payload: {
        facts: { app: row.appId, release: release.id, platform: update?.platform ?? 'unknown' },
        message: {
          title: `Emergency launches: ${(release.message ?? release.id).slice(0, 150)}`,
          ...(this.deps.appOrigin !== undefined &&
            full !== undefined && {
              url: `${this.deps.appOrigin}/workspaces/${full.workspaceId}/p/${full.projectId}/ota-hosting?app=${full.id}`,
            }),
          description: `${row.emergencyLaunches} devices fell back to the embedded bundle today (${Math.round(rate * 100)}% of ${row.activeDevices} on it). Consider rolling back.`,
          severity: Severities.error,
          fields: [
            { name: 'Runtime', value: release.runtimeVersion, inline: true },
            { name: 'Platform', value: update?.platform ?? 'unknown', inline: true },
          ],
          footer: 'Mocco OTA',
        },
      },
    }));
  }

  /** Note an update check. Synchronous and cheap; the write happens in a later batch. */
  recordCheck(sighting: DeviceSighting): void {
    const key = `${sighting.appId}|${sighting.clientId}|${sighting.currentUpdateId ?? ''}|${sighting.channel}`;
    if (!this.remember(key, this.now().getTime())) {
      return;
    }
    this.buffer.push(sighting);
    if (this.buffer.length >= FLUSH_AT) {
      this.deps.waitUntil?.(this.flush());
    } else if (this.flushing === null && this.deps.waitUntil !== undefined) {
      const pending = (async () => {
        await new Promise(resolve => {
          setTimeout(resolve, FLUSH_DELAY_MS);
        });
        await this.flush();
      })();
      this.flushing = pending;
      this.deps.waitUntil(pending);
    }
  }

  /** Write the buffered sightings (hashed). Errors are logged: metrics never fail a check. */
  async flush(): Promise<void> {
    const batch = this.buffer;
    this.buffer = [];
    this.flushing = null;
    if (batch.length === 0) {
      return;
    }
    try {
      const at = this.now();
      const rows = await Promise.all(
        batch.map(async (sighting): Promise<DeviceRow | null> => {
          const app = await this.appOf(sighting.appId);
          if (app === null) {
            return null;
          }
          return {
            workspaceId: app.workspaceId,
            appId: app.id,
            clientIdHash: deviceHashOf(app.devicePepper, sighting.clientId),
            platform: sighting.platform,
            runtimeVersion: sighting.runtimeVersion,
            channel: sighting.channel,
            currentUpdateId: sighting.currentUpdateId ?? null,
            embeddedUpdateId: sighting.embeddedUpdateId ?? null,
            firstSeenAt: at,
            lastSeenAt: at,
          };
        }),
      );
      // One row per device: the last sighting in the batch wins.
      const present = rows.filter(row => row !== null);
      const latest = present.filter(
        (row, index) =>
          present.findLastIndex(other => other.appId === row.appId && other.clientIdHash === row.clientIdHash) ===
          index,
      );
      await this.deps.metrics.upsertDevices(latest);
    } catch (error) {
      console.error('[ota-metrics] writing device sightings failed', error);
    }
  }

  /** Store a device's reported events. Unknown apps are ignored (the caller can't tell). */
  async recordEvents(appId: string, request: ClientEventsRequest): Promise<number> {
    const app = await this.appOf(appId);
    if (app === null) {
      return 0;
    }
    const at = this.now();
    const clientIdHash = deviceHashOf(app.devicePepper, request.clientId);
    await this.deps.metrics.insertEvents(
      request.events.map(event => {
        const reported = event.occurredAt === undefined ? at : new Date(event.occurredAt);
        return {
          workspaceId: app.workspaceId,
          appId: app.id,
          updateId: event.updateId,
          clientIdHash,
          type: event.type,
          detail: event.detail ?? null,
          // A device clock can be off; never in the future.
          occurredAt: new Date(Math.min(reported.getTime(), at.getTime())),
        };
      }),
    );
    return request.events.length;
  }

  /**
   * The `ota.rollupMetrics` job: roll yesterday (final) and today (so far) into the daily
   * table, then alert on releases whose emergency-launch rate today is at or over the
   * threshold (once per update and day).
   */
  async rollup(): Promise<{ alerts: number }> {
    const now = this.now();
    const today = dayOf(now);
    await this.deps.metrics.rollupDay(dayOf(new Date(now.getTime() - DAY_MS)));
    await this.deps.metrics.rollupDay(today);
    const candidates = await this.deps.metrics.listEmergencyCandidates(today, EMERGENCY_LAUNCH_ALERT.minLaunches);
    const spiking = candidates.filter(
      row => row.emergencyLaunches >= Math.max(1, row.activeDevices) * EMERGENCY_LAUNCH_ALERT.rate,
    );
    await Promise.all(spiking.map(async row => await this.alert(row, today)));
    return { alerts: spiking.length };
  }

  /** Retention: client events and devices not seen for 90 days. */
  async prune(): Promise<{ events: number; devices: number }> {
    return await this.deps.metrics.prune(new Date(this.now().getTime() - METRICS_RETENTION_DAYS * DAY_MS));
  }

  /** Adoption of the given releases: devices on them now (24 h), and per day for two weeks. */
  async releaseAdoption(app: OtaAppRow, releaseIds: readonly string[]): Promise<ReleaseAdoptionDto[]> {
    const now = this.now();
    const perRelease = await Promise.all(
      releaseIds.map(async releaseId => {
        const updates = await this.deps.releases.listOriginalUpdates(releaseId);
        return { releaseId, updateIds: updates.map(update => update.id) };
      }),
    );
    const updateIds = perRelease.flatMap(entry => entry.updateIds);
    const since = new Date(now.getTime() - DAY_MS);
    const [active, emergencies, daily] = await Promise.all([
      this.deps.metrics.countActiveByUpdate(app.id, updateIds, since),
      this.deps.metrics.countEmergencyByUpdate(app.id, updateIds, since),
      this.deps.metrics.listDaily(app.id, updateIds, dayOf(new Date(now.getTime() - 14 * DAY_MS))),
    ]);
    return perRelease.map(({ releaseId, updateIds: ids }) => {
      const days = daily
        .filter(row => ids.includes(row.updateId))
        .map(row => row.day)
        .filter((day, index, all) => all.indexOf(day) === index);
      return {
        releaseId,
        activeDevices: sumOf(active, ids, row => row.devices),
        emergencyLaunches: sumOf(emergencies, ids, row => row.launches),
        daily: days.map(day => {
          const rows = daily.filter(row => row.day === day && ids.includes(row.updateId));
          return {
            day,
            activeDevices: rows.reduce((sum, row) => sum + row.activeDevices, 0),
            newDevices: rows.reduce((sum, row) => sum + row.newDevices, 0),
            emergencyLaunches: rows.reduce((sum, row) => sum + row.emergencyLaunches, 0),
          };
        }),
      };
    });
  }

  /** Devices per channel, platform and runtime, split by the release they run (24 h). */
  async channelReach(app: OtaAppRow) {
    return await this.deps.metrics.countByChannel(app.id, new Date(this.now().getTime() - DAY_MS));
  }

  /** Monthly active devices: installs that checked in during the last 30 days (the MAU meter). */
  async monthlyActiveDevices(appId: string): Promise<number> {
    return await this.deps.metrics.countDevicesSeenSince(appId, new Date(this.now().getTime() - 30 * DAY_MS));
  }
}
