import { and, desc, eq, lte } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type PageSnapshotRow = typeof schema.statusPageSnapshots.$inferSelect;

const s = schema.statusPageSnapshots;

/** Data access for mocco_status_page_snapshots. Used by the publish job, by page id. */
export class PageSnapshotRepo {
  constructor(private readonly db: Db) {}

  /** The page's newest version. */
  async latest(pageId: string): Promise<PageSnapshotRow | undefined> {
    const [row] = await this.db.select().from(s).where(eq(s.pageId, pageId)).orderBy(desc(s.version)).limit(1);
    return row;
  }

  /** A second insert of the same (page, version) throws, so two overlapping builds can't both publish it. */
  async insert(row: typeof s.$inferInsert): Promise<PageSnapshotRow> {
    return expectOne(await this.db.insert(s).values(row).returning());
  }

  async markUploaded(id: string, at: Date): Promise<void> {
    await this.db.update(s).set({ uploadedAt: at, uploadError: null }).where(eq(s.id, id));
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.update(s).set({ uploadError: error }).where(eq(s.id, id));
  }

  /** Delete all but the page's newest `keep` versions; returns the deleted versions. */
  async prune(pageId: string, keep: number): Promise<number[]> {
    const newest = await this.db
      .select({ version: s.version })
      .from(s)
      .where(eq(s.pageId, pageId))
      .orderBy(desc(s.version))
      .limit(1)
      .offset(keep);
    const [cutoff] = newest;
    if (cutoff === undefined) {
      return [];
    }
    const rows = await this.db
      .delete(s)
      .where(and(eq(s.pageId, pageId), lte(s.version, cutoff.version)))
      .returning({ version: s.version });
    return rows.map(row => row.version);
  }
}
