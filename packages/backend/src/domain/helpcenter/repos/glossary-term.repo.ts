import { and, asc, eq, sql } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type HelpGlossaryTermRow = typeof schema.helpGlossaryTerms.$inferSelect;

type TermValues = Pick<typeof g.$inferInsert, 'term' | 'rule' | 'translations' | 'note'>;

const g = schema.helpGlossaryTerms;

/** Data access for mocco_help_glossary_terms. Scoped by workspace and project. */
export class HelpGlossaryTermRepo {
  constructor(private readonly db: Db) {}

  /** The site's terms, alphabetically (case-insensitive). */
  async list(workspaceId: string, projectId: string): Promise<HelpGlossaryTermRow[]> {
    return await this.db
      .select()
      .from(g)
      .where(and(eq(g.workspaceId, workspaceId), eq(g.projectId, projectId)))
      .orderBy(asc(sql`lower(${g.term})`), asc(g.term));
  }

  async find(workspaceId: string, projectId: string, termId: string): Promise<HelpGlossaryTermRow | undefined> {
    const [row] = await this.db
      .select()
      .from(g)
      .where(and(eq(g.workspaceId, workspaceId), eq(g.projectId, projectId), eq(g.id, termId)));
    return row;
  }

  /** Insert a term. One the site already has, in any case, throws (unique index). */
  async insert(row: { workspaceId: string; projectId: string } & TermValues): Promise<HelpGlossaryTermRow> {
    try {
      return expectOne(await this.db.insert(g).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /** Replace a term's values; undefined when it isn't in the project. A taken term throws (unique index). */
  async update(
    workspaceId: string,
    projectId: string,
    termId: string,
    values: TermValues,
  ): Promise<HelpGlossaryTermRow | undefined> {
    try {
      const [row] = await this.db
        .update(g)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(g.workspaceId, workspaceId), eq(g.projectId, projectId), eq(g.id, termId)))
        .returning();
      return row;
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /** Delete a term; whether it was there. */
  async delete(workspaceId: string, projectId: string, termId: string): Promise<boolean> {
    const rows = await this.db
      .delete(g)
      .where(and(eq(g.workspaceId, workspaceId), eq(g.projectId, projectId), eq(g.id, termId)))
      .returning({ id: g.id });
    return rows.length > 0;
  }
}
