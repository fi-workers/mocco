import { MonitorStates } from '@mocco/common/status';
import { and, asc, eq, exists, gte, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type LocationRow = typeof schema.statusLocations.$inferSelect;

const l = schema.statusLocations;
/** A workspace may use the shared locations and its own. */
const visibleTo = (workspaceId: string) => or(isNull(l.workspaceId), eq(l.workspaceId, workspaceId));

/** Data access for mocco_status_locations. A workspace sees the shared (hosted and embedded)
 * locations and its own private ones; it changes only its own. */
export class LocationRepo {
  constructor(private readonly db: Db) {}

  /** The enabled shared locations and every one of the workspace's own. */
  async listVisible(workspaceId: string): Promise<LocationRow[]> {
    return await this.db
      .select()
      .from(l)
      .where(or(and(isNull(l.workspaceId), isNull(l.disabledAt)), eq(l.workspaceId, workspaceId)))
      .orderBy(asc(l.kind), asc(l.code));
  }

  /** The enabled location a token hash authenticates, of any workspace or none. */
  async findEnabledByTokenHash(tokenHash: string): Promise<LocationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(l)
      .where(and(eq(l.tokenHash, tokenHash), isNull(l.disabledAt)));
    return row;
  }

  /** Record that the location's agent was seen (any probe call). */
  async recordSeen(id: string, values: { lastSeenAt: Date; agentVersion: string }): Promise<void> {
    await this.db.update(l).set(values).where(eq(l.id, id));
  }

  /** One of the workspace's own (private) locations. */
  async findOwn(workspaceId: string, id: string): Promise<LocationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(l)
      .where(and(eq(l.workspaceId, workspaceId), eq(l.id, id)));
    return row;
  }

  /** The ids among `ids` that the workspace may assign a monitor to: enabled, shared or its own. */
  async usableIds(workspaceId: string, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .select({ id: l.id })
      .from(l)
      .where(and(visibleTo(workspaceId), isNull(l.disabledAt), inArray(l.id, [...ids])));
    return rows.map(row => row.id);
  }

  /**
   * The shared location with `row.code`, inserted from `row` when there is none yet. Two
   * callers racing both get the one row: the insert does nothing on the code's unique index.
   */
  async ensureShared(row: Omit<typeof l.$inferInsert, 'workspaceId'>): Promise<LocationRow> {
    await this.db
      .insert(l)
      .values({ ...row, workspaceId: null })
      .onConflictDoNothing();
    return expectOne(
      await this.db
        .select()
        .from(l)
        .where(and(isNull(l.workspaceId), eq(l.code, row.code))),
    );
  }

  /**
   * Mark silent the enabled locations last seen before `cutoff` that some unpaused monitor
   * runs at and that aren't marked yet; the rows marked. A location never seen isn't silent: it
   * hasn't started.
   */
  async markSilent(cutoff: Date, now: Date): Promise<LocationRow[]> {
    const ml = schema.statusMonitorLocations;
    const m = schema.statusMonitors;
    const isInUse = exists(
      this.db
        .select({ one: ml.locationId })
        .from(ml)
        .innerJoin(m, eq(m.id, ml.monitorId))
        .where(and(eq(ml.locationId, l.id), ne(m.state, MonitorStates.paused))),
    );
    return await this.db
      .update(l)
      .set({ unhealthySince: now })
      .where(and(isNull(l.disabledAt), isNull(l.unhealthySince), lt(l.lastSeenAt, cutoff), isInUse))
      .returning();
  }

  /** The silent locations seen at or after `cutoff`: their probes are back. */
  async listHeardSince(cutoff: Date): Promise<LocationRow[]> {
    return await this.db
      .select()
      .from(l)
      .where(and(isNotNull(l.unhealthySince), gte(l.lastSeenAt, cutoff)));
  }

  /** Clear the silent mark of `ids`. */
  async clearSilent(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .update(l)
      .set({ unhealthySince: null })
      .where(and(inArray(l.id, [...ids]), isNotNull(l.unhealthySince)));
  }

  async insert(row: typeof l.$inferInsert): Promise<LocationRow> {
    try {
      return expectOne(await this.db.insert(l).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  async updateOwn(
    workspaceId: string,
    id: string,
    values: { tokenHash?: string; disabledAt?: Date },
  ): Promise<LocationRow | undefined> {
    const [row] = await this.db
      .update(l)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(l.workspaceId, workspaceId), eq(l.id, id)))
      .returning();
    return row;
  }
}
