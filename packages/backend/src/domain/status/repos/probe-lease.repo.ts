import { MonitorStates } from '@mocco/common/status';
import { and, asc, eq, inArray, isNull, lte, ne, notExists, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { MonitorSpec } from '@mocco/common/status';

export type ProbeLeaseRow = typeof schema.statusProbeLeases.$inferSelect;

const l = schema.statusProbeLeases;
const m = schema.statusMonitors;
const ml = schema.statusMonitorLocations;

/** A round due at a location, before it is leased. */
export interface DueRound {
  monitorId: string;
  workspaceId: string;
  roundAt: Date;
  spec: MonitorSpec;
}

/** Data access for mocco_status_probe_leases. Every lookup is scoped by location. */
export class ProbeLeaseRepo {
  constructor(private readonly db: Db) {}

  /**
   * Lease the rounds due at a location by `horizon`, at most `limit`, in one transaction. The
   * monitor's (monitor, location) assignment rows are locked `FOR UPDATE SKIP LOCKED`, so a
   * concurrent call from the same location takes other rounds instead of waiting, and the unique
   * (monitor, location, round) index makes a second lease of a round impossible either way.
   * Different locations lock different rows and never compete. `expiresAt` comes from the caller.
   */
  async leaseDue(opts: {
    locationId: string;
    /** A private location's workspace: it may only lease that workspace's monitors. */
    workspaceId: string | null;
    horizon: Date;
    limit: number;
    leasedAt: Date;
    expiresAt: (round: DueRound) => Date;
  }): Promise<(ProbeLeaseRow & { spec: MonitorSpec })[]> {
    return await this.db.transaction(async tx => {
      const due = await tx
        .select({ monitorId: m.id, workspaceId: m.workspaceId, roundAt: m.nextRoundAt, spec: m.spec })
        .from(ml)
        .innerJoin(m, and(eq(m.id, ml.monitorId), eq(m.workspaceId, ml.workspaceId)))
        .where(
          and(
            eq(ml.locationId, opts.locationId),
            opts.workspaceId === null ? undefined : eq(ml.workspaceId, opts.workspaceId),
            ne(m.state, MonitorStates.paused),
            lte(m.nextRoundAt, opts.horizon),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(l)
                .where(and(eq(l.monitorId, m.id), eq(l.locationId, ml.locationId), eq(l.roundAt, m.nextRoundAt))),
            ),
          ),
        )
        .orderBy(asc(m.nextRoundAt))
        .limit(opts.limit)
        .for('update', { of: ml, skipLocked: true });
      if (due.length === 0) {
        return [];
      }
      const leased = await tx
        .insert(l)
        .values(
          due.map(round => ({
            workspaceId: round.workspaceId,
            monitorId: round.monitorId,
            locationId: opts.locationId,
            roundAt: round.roundAt,
            leasedAt: opts.leasedAt,
            expiresAt: opts.expiresAt(round),
          })),
        )
        .onConflictDoNothing({ target: [l.monitorId, l.locationId, l.roundAt] })
        .returning();
      const specs = new Map(due.map(round => [round.monitorId, round.spec]));
      return leased.flatMap(lease => {
        const spec = specs.get(lease.monitorId);
        return spec === undefined ? [] : [{ ...lease, spec }];
      });
    });
  }

  /** The location's leases among `ids`; another location's lease is simply not found. */
  async findForLocation(locationId: string, ids: readonly string[]): Promise<ProbeLeaseRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(l)
      .where(and(eq(l.locationId, locationId), inArray(l.id, [...ids])));
  }

  async markReported(locationId: string, ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .update(l)
      .set({ reportedAt: at })
      .where(and(eq(l.locationId, locationId), inArray(l.id, [...ids]), isNull(l.reportedAt)));
  }
}
