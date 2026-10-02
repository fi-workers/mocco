import { ObjectStatuses } from '@mocco/common/storage';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type StoredObjectRow = typeof schema.objects.$inferSelect;

/** Data access for mocco_objects. Every read by id is scoped by `workspace_id`. */
export class ObjectRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.objects.$inferInsert) {
    return expectOne(await this.db.insert(schema.objects).values(row).returning());
  }

  /** An object of the workspace — or throw EntityNotFoundError. */
  async getInWorkspace(workspaceId: string, id: string) {
    const rows = await this.db
      .select()
      .from(schema.objects)
      .where(and(eq(schema.objects.id, id), eq(schema.objects.workspaceId, workspaceId)));
    return getOrThrow(rows, `Object ${id} was not found`);
  }

  /** Bytes the workspace holds or has reserved (pending + ready). */
  async usedBytes(workspaceId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${schema.objects.sizeBytes}), 0)` })
      .from(schema.objects)
      .where(
        and(
          eq(schema.objects.workspaceId, workspaceId),
          inArray(schema.objects.status, [ObjectStatuses.pending, ObjectStatuses.ready]),
        ),
      );
    return Number(row?.total ?? 0);
  }

  /** Mark a pending upload ready with its verified size. Undefined if it wasn't pending. */
  async markReady(workspaceId: string, id: string, sizeBytes: number, readyAt: Date) {
    const [row] = await this.db
      .update(schema.objects)
      .set({ status: ObjectStatuses.ready, sizeBytes, readyAt })
      .where(
        and(
          eq(schema.objects.id, id),
          eq(schema.objects.workspaceId, workspaceId),
          eq(schema.objects.status, ObjectStatuses.pending),
        ),
      )
      .returning();
    return row;
  }

  async markDeleted(ids: readonly string[], deletedAt: Date) {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .update(schema.objects)
      .set({ status: ObjectStatuses.deleted, deletedAt })
      .where(inArray(schema.objects.id, [...ids]));
  }

  /** Pending uploads created before `before` (abandoned), oldest first. */
  async listStalePending(before: Date, limit: number) {
    return await this.db
      .select({ id: schema.objects.id, key: schema.objects.key })
      .from(schema.objects)
      .where(and(eq(schema.objects.status, ObjectStatuses.pending), lt(schema.objects.createdAt, before)))
      .orderBy(schema.objects.createdAt)
      .limit(limit);
  }

  /** Deleted objects whose row is past retention. */
  async listExpiredDeleted(before: Date, limit: number) {
    return await this.db
      .select({ id: schema.objects.id, key: schema.objects.key })
      .from(schema.objects)
      .where(and(eq(schema.objects.status, ObjectStatuses.deleted), lt(schema.objects.deletedAt, before)))
      .limit(limit);
  }

  async hardDelete(ids: readonly string[]) {
    if (ids.length === 0) {
      return;
    }
    await this.db.delete(schema.objects).where(inArray(schema.objects.id, [...ids]));
  }
}
