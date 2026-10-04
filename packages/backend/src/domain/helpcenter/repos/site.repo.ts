import { and, eq } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type HelpSiteRow = typeof schema.helpSites.$inferSelect;

const s = schema.helpSites;

/** Data access for mocco_help_sites. Scoped by workspace and project, except the public lookup by slug. */
export class HelpSiteRepo {
  constructor(private readonly db: Db) {}

  async find(workspaceId: string, projectId: string): Promise<HelpSiteRow | undefined> {
    const [row] = await this.db
      .select()
      .from(s)
      .where(and(eq(s.workspaceId, workspaceId), eq(s.projectId, projectId)));
    return row;
  }

  /** The public lookup: the site and its project's name. */
  async findBySlug(slug: string): Promise<(HelpSiteRow & { name: string }) | undefined> {
    const [row] = await this.db
      .select({ site: s, name: schema.projects.name })
      .from(s)
      .innerJoin(schema.projects, eq(schema.projects.id, s.projectId))
      .where(eq(s.slug, slug));
    return row === undefined ? undefined : { ...row.site, name: row.name };
  }

  /** Insert, or undefined when the project already has a site. A taken slug throws (unique index). */
  async insert(row: typeof s.$inferInsert): Promise<HelpSiteRow | undefined> {
    try {
      const [inserted] = await this.db.insert(s).values(row).onConflictDoNothing({ target: s.projectId }).returning();
      return inserted;
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  async update(
    workspaceId: string,
    projectId: string,
    values: { slug?: string; sourceLocale?: string; locales?: string[]; allowAiTraining?: boolean },
  ) {
    try {
      return expectOne(
        await this.db
          .update(s)
          .set({ ...values, updatedAt: new Date() })
          .where(and(eq(s.workspaceId, workspaceId), eq(s.projectId, projectId)))
          .returning(),
      );
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }
}
