import { and, eq, inArray, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { SegmentOrigin } from '@mocco/common/help';

export type HelpSegmentMemoryRow = typeof schema.helpSegmentMemory.$inferSelect;

const m = schema.helpSegmentMemory;

/** Data access for mocco_help_segment_memory (translation memory). Scoped by workspace and project. */
export class HelpSegmentMemoryRepo {
  constructor(private readonly db: Db) {}

  /** The entries for these source hashes in `locale`, of either origin (or only `origins`). */
  async lookup(
    scope: { workspaceId: string; projectId: string; locale: string },
    hashes: readonly string[],
    origins?: readonly SegmentOrigin[],
  ): Promise<HelpSegmentMemoryRow[]> {
    if (hashes.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(m)
      .where(
        and(
          eq(m.workspaceId, scope.workspaceId),
          eq(m.projectId, scope.projectId),
          eq(m.locale, scope.locale),
          inArray(m.sourceHash, [...hashes]),
          ...(origins === undefined ? [] : [inArray(m.origin, [...origins])]),
        ),
      );
  }

  /** Store translations of one origin, replacing that origin's earlier text for the same source. */
  async put(
    scope: { workspaceId: string; projectId: string; locale: string },
    origin: SegmentOrigin,
    entries: readonly { sourceHash: string; text: string }[],
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.db
      .insert(m)
      .values(entries.map(entry => ({ ...scope, origin, sourceHash: entry.sourceHash, text: entry.text })))
      .onConflictDoUpdate({
        target: [m.projectId, m.locale, m.sourceHash, m.origin],
        set: { text: sql`excluded.text`, updatedAt: new Date() },
      });
  }
}
