import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';

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
