import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';

import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type ApiKeyRow = typeof schema.apiKeys.$inferSelect;

/** Data access for mocco_api_keys. Reads by id are scoped by workspace and project. */
export class ApiKeyRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.apiKeys.$inferInsert) {
    return expectOne(await this.db.insert(schema.apiKeys).values(row).returning());
  }

  /** A project's keys, newest first (revoked ones included, for the record). */
  async listByProject(workspaceId: string, projectId: string) {
    return await this.db
      .select()
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.workspaceId, workspaceId), eq(schema.apiKeys.projectId, projectId)))
      .orderBy(desc(schema.apiKeys.createdAt));
  }

  /** A key of the project — or throw EntityNotFoundError. */
  async getInProject(workspaceId: string, projectId: string, id: string) {
    const rows = await this.db
      .select()
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.id, id),
          eq(schema.apiKeys.workspaceId, workspaceId),
          eq(schema.apiKeys.projectId, projectId),
        ),
      );
    return getOrThrow(rows, `API key ${id} was not found`);
  }

  /** The key with this token hash, if any (revoked and expired ones included). */
  async findByHash(tokenHash: string) {
    const [row] = await this.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.tokenHash, tokenHash));
    return row;
  }

  async revoke(id: string, revokedAt: Date) {
    const [row] = await this.db
      .update(schema.apiKeys)
      .set({ revokedAt })
      .where(and(eq(schema.apiKeys.id, id), isNull(schema.apiKeys.revokedAt)))
      .returning();
    return row;
  }

  /** Record a use, at most once per `minIntervalMs` per key (a cheap conditional update). */
  async touch(id: string, now: Date, minIntervalMs: number) {
    await this.db
      .update(schema.apiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(schema.apiKeys.id, id),
          or(isNull(schema.apiKeys.lastUsedAt), lt(schema.apiKeys.lastUsedAt, new Date(now.getTime() - minIntervalMs))),
        ),
      );
  }
}
