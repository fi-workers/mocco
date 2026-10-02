import { and, eq, inArray, or } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type HelpNodeTranslationRow = typeof schema.helpNodeTranslations.$inferSelect;

const n = schema.helpNodeTranslations;

/** A collection or a section: the two kinds of node whose titles are translated. */
export type HelpNode = { collectionId: string } | { sectionId: string };

/** Data access for mocco_help_node_translations. Scoped by workspace. */
export class HelpNodeTranslationRepo {
  constructor(private readonly db: Db) {}

  /** The titles in `locale` of these collections and sections. */
  async inLocale(
    workspaceId: string,
    locale: string,
    ids: { collectionIds: readonly string[]; sectionIds: readonly string[] },
  ): Promise<HelpNodeTranslationRow[]> {
    const nodes = [
      ...(ids.collectionIds.length > 0 ? [inArray(n.collectionId, [...ids.collectionIds])] : []),
      ...(ids.sectionIds.length > 0 ? [inArray(n.sectionId, [...ids.sectionIds])] : []),
    ];
    if (nodes.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(n)
      .where(and(eq(n.workspaceId, workspaceId), eq(n.locale, locale), or(...nodes)));
  }

  async upsert(row: { workspaceId: string; locale: string; title: string; sourceTitle: string } & HelpNode) {
    const isCollection = 'collectionId' in row;
    await this.db
      .insert(n)
      .values({
        workspaceId: row.workspaceId,
        locale: row.locale,
        title: row.title,
        sourceTitle: row.sourceTitle,
        collectionId: isCollection ? row.collectionId : null,
        sectionId: isCollection ? null : row.sectionId,
      })
      .onConflictDoUpdate({
        target: isCollection ? [n.collectionId, n.locale] : [n.sectionId, n.locale],
        set: { title: row.title, sourceTitle: row.sourceTitle, updatedAt: new Date() },
      });
  }
}
