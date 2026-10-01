import { OtaClientEventTypes } from '@mocco/common/ota-hosting';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type DeviceRow = typeof schema.otaDevices.$inferInsert;
export type ClientEventRow = typeof schema.otaClientEvents.$inferInsert;

/** Data access for OTA device state, client events and the daily adoption rollup. */
export class OtaMetricsRepo {
  constructor(private readonly db: Db) {}

  /** Record each device's latest state (first sight keeps its first_seen_at). */
  async upsertDevices(rows: readonly DeviceRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.db
      .insert(schema.otaDevices)
      .values([...rows])
      .onConflictDoUpdate({
        target: [schema.otaDevices.appId, schema.otaDevices.clientIdHash],
        set: {
          platform: sql`excluded.platform`,
          runtimeVersion: sql`excluded.runtime_version`,
          channel: sql`excluded.channel`,
          currentUpdateId: sql`excluded.current_update_id`,
          embeddedUpdateId: sql`excluded.embedded_update_id`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      });
  }

  async insertEvents(rows: readonly ClientEventRow[]): Promise<void> {
    if (rows.length > 0) {
      await this.db.insert(schema.otaClientEvents).values([...rows]);
    }
  }

  /**
   * Roll `day` (UTC, `YYYY-MM-DD`) up into mocco_ota_adoption_daily: per update, the
   * devices last seen on it that day, the ones first seen that day, and the emergency
   * launches reported for it. Idempotent: a re-run replaces the day's counts.
   */
  async rollupDay(day: string): Promise<void> {
    const start = sql`${day}::date`;
    const end = sql`(${day}::date + interval '1 day')`;
    await this.db.execute(sql`
      INSERT INTO ${schema.otaAdoptionDaily} (workspace_id, app_id, update_id, day, active_devices, new_devices, emergency_launches)
      SELECT workspace_id, app_id, update_id, ${day}::date, sum(active)::int, sum(fresh)::int, sum(emergencies)::int
      FROM (
        SELECT workspace_id, app_id, current_update_id AS update_id, 1 AS active,
               CASE WHEN first_seen_at >= ${start} THEN 1 ELSE 0 END AS fresh, 0 AS emergencies
        FROM ${schema.otaDevices}
        WHERE current_update_id IS NOT NULL AND last_seen_at >= ${start} AND last_seen_at < ${end}
        UNION ALL
        SELECT workspace_id, app_id, update_id, 0, 0, 1
        FROM ${schema.otaClientEvents}
        WHERE update_id IS NOT NULL AND type = ${OtaClientEventTypes.emergencyLaunch}
          AND occurred_at >= ${start} AND occurred_at < ${end}
      ) AS facts
      GROUP BY workspace_id, app_id, update_id
      ON CONFLICT (app_id, update_id, day) DO UPDATE SET
        active_devices = excluded.active_devices,
        new_devices = excluded.new_devices,
        emergency_launches = excluded.emergency_launches
    `);
  }

  /** The day's rollup rows with at least `minLaunches` emergency launches. */
  async listEmergencyCandidates(day: string, minLaunches: number) {
    return await this.db
      .select()
      .from(schema.otaAdoptionDaily)
      .where(and(eq(schema.otaAdoptionDaily.day, day), gte(schema.otaAdoptionDaily.emergencyLaunches, minLaunches)));
  }

  /** Devices whose last check within the window reported each update. */
  async countActiveByUpdate(appId: string, updateIds: readonly string[], since: Date) {
    if (updateIds.length === 0) {
      return [];
    }
    return await this.db
      .select({ updateId: schema.otaDevices.currentUpdateId, devices: sql<number>`count(*)::int` })
      .from(schema.otaDevices)
      .where(
        and(
          eq(schema.otaDevices.appId, appId),
          inArray(schema.otaDevices.currentUpdateId, [...updateIds]),
          gte(schema.otaDevices.lastSeenAt, since),
        ),
      )
      .groupBy(schema.otaDevices.currentUpdateId);
  }

  async countEmergencyByUpdate(appId: string, updateIds: readonly string[], since: Date) {
    if (updateIds.length === 0) {
      return [];
    }
    return await this.db
      .select({ updateId: schema.otaClientEvents.updateId, launches: sql<number>`count(*)::int` })
      .from(schema.otaClientEvents)
      .where(
        and(
          eq(schema.otaClientEvents.appId, appId),
          inArray(schema.otaClientEvents.updateId, [...updateIds]),
          eq(schema.otaClientEvents.type, OtaClientEventTypes.emergencyLaunch),
          gte(schema.otaClientEvents.occurredAt, since),
        ),
      )
      .groupBy(schema.otaClientEvents.updateId);
  }

  async listDaily(appId: string, updateIds: readonly string[], sinceDay: string) {
    if (updateIds.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(schema.otaAdoptionDaily)
      .where(
        and(
          eq(schema.otaAdoptionDaily.appId, appId),
          inArray(schema.otaAdoptionDaily.updateId, [...updateIds]),
          gte(schema.otaAdoptionDaily.day, sinceDay),
        ),
      )
      .orderBy(schema.otaAdoptionDaily.day);
  }

  /** Devices per channel, platform, runtime and the release of their current update (rollout reach). */
  async countByChannel(appId: string, since: Date) {
    return await this.db
      .select({
        channel: schema.otaDevices.channel,
        platform: schema.otaDevices.platform,
        runtimeVersion: schema.otaDevices.runtimeVersion,
        releaseId: schema.otaUpdates.releaseId,
        devices: sql<number>`count(*)::int`,
      })
      .from(schema.otaDevices)
      .leftJoin(schema.otaUpdates, eq(schema.otaUpdates.id, schema.otaDevices.currentUpdateId))
      .where(and(eq(schema.otaDevices.appId, appId), gte(schema.otaDevices.lastSeenAt, since)))
      .groupBy(
        schema.otaDevices.channel,
        schema.otaDevices.platform,
        schema.otaDevices.runtimeVersion,
        schema.otaUpdates.releaseId,
      );
  }

  /** Retention: drop client events and silent devices older than `before`. */
  async prune(before: Date): Promise<{ events: number; devices: number }> {
    const events = await this.db
      .delete(schema.otaClientEvents)
      .where(lt(schema.otaClientEvents.occurredAt, before))
      .returning({ id: schema.otaClientEvents.id });
    const devices = await this.db
      .delete(schema.otaDevices)
      .where(lt(schema.otaDevices.lastSeenAt, before))
      .returning({ hash: schema.otaDevices.clientIdHash });
    return { events: events.length, devices: devices.length };
  }

  /** Monthly active devices of an app (installs seen since `since`): the MAU meter. */
  async countDevicesSeenSince(appId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ devices: sql<number>`count(*)::int` })
      .from(schema.otaDevices)
      .where(and(eq(schema.otaDevices.appId, appId), gte(schema.otaDevices.lastSeenAt, since)));
    return row?.devices ?? 0;
  }
}
