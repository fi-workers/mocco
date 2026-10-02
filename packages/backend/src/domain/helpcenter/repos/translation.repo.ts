import { and, eq, inArray } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type HelpTranslationRow = typeof schema.helpTranslations.$inferSelect;

const t = schema.helpTranslations;

/** Data access for mocco_help_translations. Scoped by workspace. */
export class HelpTranslationRepo {
  constructor(private readonly db: Db) {}

  async find(workspaceId: string, articleId: string, locale: string): Promise<HelpTranslationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t)
      .where(and(eq(t.workspaceId, workspaceId), eq(t.articleId, articleId), eq(t.locale, locale)));
    return row;
  }

  async forArticle(workspaceId: string, articleId: string): Promise<HelpTranslationRow[]> {
    return await this.db
      .select()
      .from(t)
      .where(and(eq(t.workspaceId, workspaceId), eq(t.articleId, articleId)));
  }

  /** The translations of these articles into `locale` that have text. */
  async withText(articleIds: readonly string[], locale: string): Promise<HelpTranslationRow[]> {
    if (articleIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .select()
      .from(t)
      .where(and(inArray(t.articleId, [...articleIds]), eq(t.locale, locale)));
    return rows.filter(row => row.revisionId !== null);
  }

  /** Create or replace the row for (article, locale). */
  async upsert(
    row: Pick<typeof t.$inferInsert, 'workspaceId' | 'articleId' | 'locale' | 'state'> &
      Partial<Pick<typeof t.$inferInsert, 'revisionId' | 'sourceHash' | 'lastError' | 'reviewedByUserId'>>,
  ): Promise<HelpTranslationRow> {
    const changes = {
      state: row.state,
      ...(row.revisionId !== undefined && { revisionId: row.revisionId }),
      ...(row.sourceHash !== undefined && { sourceHash: row.sourceHash }),
      ...(row.lastError !== undefined && { lastError: row.lastError }),
      ...(row.reviewedByUserId !== undefined && { reviewedByUserId: row.reviewedByUserId }),
    };
    return expectOne(
      await this.db
        .insert(t)
        .values(row)
        .onConflictDoUpdate({ target: [t.articleId, t.locale], set: { ...changes, updatedAt: new Date() } })
        .returning(),
    );
  }
}
