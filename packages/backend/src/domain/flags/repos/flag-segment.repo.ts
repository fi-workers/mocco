import { and, asc, eq, inArray } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type FlagSegmentRow = typeof schema.flagSegments.$inferSelect;

/** Data access for mocco_flag_segments. Every query is scoped by `workspace_id`. */
export class FlagSegmentRepo {
  constructor(private readonly db: Db) {}

  async listForEnvironment(workspaceId: string, environmentId: string) {
    return await this.db
      .select()
      .from(schema.flagSegments)
      .where(
        and(eq(schema.flagSegments.workspaceId, workspaceId), eq(schema.flagSegments.environmentId, environmentId)),
      )
      .orderBy(asc(schema.flagSegments.key));
  }

  async upsert(rows: (typeof schema.flagSegments.$inferInsert)[]) {
    await Promise.all(
      rows.map(
        async row =>
          await this.db
            .insert(schema.flagSegments)
            .values(row)
            .onConflictDoUpdate({
              target: [schema.flagSegments.environmentId, schema.flagSegments.key],
              set: {
                name: row.name,
                includedKeys: row.includedKeys,
                excludedKeys: row.excludedKeys,
                rules: row.rules,
                version: row.version,
              },
            }),
      ),
    );
  }

  async delete(workspaceId: string, environmentId: string, keys: readonly string[]) {
    if (keys.length === 0) {
      return;
    }
    await this.db
      .delete(schema.flagSegments)
      .where(
        and(
          eq(schema.flagSegments.workspaceId, workspaceId),
          eq(schema.flagSegments.environmentId, environmentId),
          inArray(schema.flagSegments.key, [...keys]),
        ),
      );
  }
}
