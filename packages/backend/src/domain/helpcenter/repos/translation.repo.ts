import { and, eq, inArray, sql } from 'drizzle-orm';

import { AdvisoryLockNamespaces } from '@backend/infra/db/advisory-locks';
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

  /** The translation and the name (or email) of the person who last reviewed it, null when unknown. */
  async findWithReviewer(
    workspaceId: string,
    articleId: string,
    locale: string,
  ): Promise<{ row: HelpTranslationRow; reviewer: string | null } | undefined> {
    const [found] = await this.db
      .select({ row: t, name: schema.users.name, email: schema.users.email })
      .from(t)
      .leftJoin(schema.users, eq(t.reviewedByUserId, schema.users.id))
      .where(and(eq(t.workspaceId, workspaceId), eq(t.articleId, articleId), eq(t.locale, locale)));
    return found === undefined ? undefined : { row: found.row, reviewer: found.name ?? found.email };
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

  /**
   * Hold (article, locale) until the caller's transaction ends, so claims and results of
   * its translation never interleave. Only inside a transaction (`_xact_`, see advisory-locks.ts).
   */
  async lock(articleId: string, locale: string): Promise<void> {
    const key = `${articleId}:${locale}`;
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(${AdvisoryLockNamespaces.helpTranslation}, hashtext(${key}))`,
    );
  }

  /** Create or replace the row for (article, locale); fields left out keep their value. */
  async upsert(
    row: Pick<typeof t.$inferInsert, 'workspaceId' | 'articleId' | 'locale' | 'state'> &
      Partial<
        Pick<
          typeof t.$inferInsert,
          | 'revisionId'
          | 'sourceHash'
          | 'lastError'
          | 'reviewedByUserId'
          | 'proposalRevisionId'
          | 'proposalSourceHash'
          | 'claimedUntil'
        >
      >,
  ): Promise<HelpTranslationRow> {
    const changes = {
      state: row.state,
      ...(row.revisionId !== undefined && { revisionId: row.revisionId }),
      ...(row.sourceHash !== undefined && { sourceHash: row.sourceHash }),
      ...(row.lastError !== undefined && { lastError: row.lastError }),
      ...(row.reviewedByUserId !== undefined && { reviewedByUserId: row.reviewedByUserId }),
      ...(row.proposalRevisionId !== undefined && { proposalRevisionId: row.proposalRevisionId }),
      ...(row.proposalSourceHash !== undefined && { proposalSourceHash: row.proposalSourceHash }),
      ...(row.claimedUntil !== undefined && { claimedUntil: row.claimedUntil }),
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
