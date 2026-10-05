import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type HelpArticleRow = typeof schema.helpArticles.$inferSelect;
export type HelpRevisionRow = typeof schema.helpRevisions.$inferSelect;

const a = schema.helpArticles;
const r = schema.helpRevisions;
const redirects = schema.helpRedirects;

/** Data access for mocco_help_articles, their revisions and redirects. Scoped by workspace and project. */
export class HelpArticleRepo {
  constructor(private readonly db: Db) {}

  async find(workspaceId: string, projectId: string, articleId: string): Promise<HelpArticleRow | undefined> {
    const [row] = await this.db
      .select()
      .from(a)
      .where(and(eq(a.id, articleId), eq(a.workspaceId, workspaceId), eq(a.projectId, projectId)));
    return row;
  }

  async byIds(workspaceId: string, ids: readonly string[]): Promise<HelpArticleRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(a)
      .where(and(eq(a.workspaceId, workspaceId), inArray(a.id, [...ids])));
  }

  async findByShortId(projectId: string, shortId: string): Promise<HelpArticleRow | undefined> {
    const [row] = await this.db
      .select()
      .from(a)
      .where(and(eq(a.projectId, projectId), eq(a.shortId, shortId)));
    return row;
  }

  async inSections(workspaceId: string, sectionIds: readonly string[]): Promise<HelpArticleRow[]> {
    if (sectionIds.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(a)
      .where(and(eq(a.workspaceId, workspaceId), inArray(a.sectionId, [...sectionIds])))
      .orderBy(asc(a.position), asc(a.createdAt));
  }

  /** An article placed last in its section. A clashing short id throws (unique index). */
  async insert(row: Omit<typeof a.$inferInsert, 'position'>): Promise<HelpArticleRow> {
    const [last] = await this.db
      .select({ position: max(a.position) })
      .from(a)
      .where(eq(a.sectionId, row.sectionId));
    try {
      return expectOne(
        await this.db
          .insert(a)
          .values({ ...row, position: (last?.position ?? -1) + 1 })
          .returning(),
      );
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  async update(articleId: string, values: Partial<Omit<typeof a.$inferInsert, 'id' | 'workspaceId' | 'projectId'>>) {
    return expectOne(
      await this.db
        .update(a)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(a.id, articleId))
        .returning(),
    );
  }

  async delete(workspaceId: string, articleId: string): Promise<void> {
    await this.db.delete(a).where(and(eq(a.id, articleId), eq(a.workspaceId, workspaceId)));
  }

  async insertRevision(row: typeof r.$inferInsert): Promise<HelpRevisionRow> {
    return expectOne(await this.db.insert(r).values(row).returning());
  }

  /** Rewrite a draft revision's text (an editing session's saves land in one revision). */
  async updateRevisionText(
    workspaceId: string,
    revisionId: string,
    text: Pick<typeof r.$inferInsert, 'title' | 'bodyMd' | 'contentHash'>,
  ): Promise<HelpRevisionRow> {
    return expectOne(
      await this.db
        .update(r)
        .set(text)
        .where(and(eq(r.id, revisionId), eq(r.workspaceId, workspaceId)))
        .returning(),
    );
  }

  async findRevision(workspaceId: string, revisionId: string): Promise<HelpRevisionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(r)
      .where(and(eq(r.id, revisionId), eq(r.workspaceId, workspaceId)));
    return row;
  }

  async revisionsByIds(ids: readonly string[]): Promise<HelpRevisionRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(r)
      .where(inArray(r.id, [...ids]));
  }

  /** An article's revisions in one language, newest first. */
  async history(workspaceId: string, articleId: string, locale: string, limit: number): Promise<HelpRevisionRow[]> {
    return await this.db
      .select()
      .from(r)
      .where(and(eq(r.workspaceId, workspaceId), eq(r.articleId, articleId), eq(r.locale, locale)))
      .orderBy(desc(r.createdAt))
      .limit(limit);
  }

  async insertRedirect(row: typeof redirects.$inferInsert): Promise<void> {
    await this.db
      .insert(redirects)
      .values(row)
      .onConflictDoUpdate({ target: [redirects.projectId, redirects.fromPath], set: { articleId: row.articleId } });
  }

  async findRedirect(projectId: string, fromPath: string) {
    const [row] = await this.db
      .select()
      .from(redirects)
      .where(and(eq(redirects.projectId, projectId), eq(redirects.fromPath, fromPath)));
    return row;
  }
}
