import { and, asc, eq, inArray, max } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type HelpCollectionRow = typeof schema.helpCollections.$inferSelect;
export type HelpSectionRow = typeof schema.helpSections.$inferSelect;

const c = schema.helpCollections;
const sec = schema.helpSections;

/** Data access for mocco_help_collections and mocco_help_sections. Scoped by workspace and project. */
export class HelpTreeRepo {
  constructor(private readonly db: Db) {}

  async collections(workspaceId: string, projectId: string): Promise<HelpCollectionRow[]> {
    return await this.db
      .select()
      .from(c)
      .where(and(eq(c.workspaceId, workspaceId), eq(c.projectId, projectId)))
      .orderBy(asc(c.position), asc(c.createdAt));
  }

  async sections(workspaceId: string, collectionIds: readonly string[]): Promise<HelpSectionRow[]> {
    if (collectionIds.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(sec)
      .where(and(eq(sec.workspaceId, workspaceId), inArray(sec.collectionId, [...collectionIds])))
      .orderBy(asc(sec.position), asc(sec.createdAt));
  }

  async findCollection(workspaceId: string, projectId: string, collectionId: string) {
    const [row] = await this.db
      .select()
      .from(c)
      .where(and(eq(c.id, collectionId), eq(c.workspaceId, workspaceId), eq(c.projectId, projectId)));
    return row;
  }

  /** The section, if its collection is in the project. */
  async findSection(workspaceId: string, projectId: string, sectionId: string) {
    const [row] = await this.db
      .select({ section: sec, collection: c })
      .from(sec)
      .innerJoin(c, eq(c.id, sec.collectionId))
      .where(and(eq(sec.id, sectionId), eq(sec.workspaceId, workspaceId), eq(c.projectId, projectId)));
    return row;
  }

  /** A collection, placed last. A taken slug throws (unique index). */
  async insertCollection(row: Omit<typeof c.$inferInsert, 'position'>): Promise<HelpCollectionRow> {
    const [last] = await this.db
      .select({ position: max(c.position) })
      .from(c)
      .where(eq(c.projectId, row.projectId));
    try {
      return expectOne(
        await this.db
          .insert(c)
          .values({ ...row, position: (last?.position ?? -1) + 1 })
          .returning(),
      );
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  async insertSection(row: Omit<typeof sec.$inferInsert, 'position'>): Promise<HelpSectionRow> {
    const [last] = await this.db
      .select({ position: max(sec.position) })
      .from(sec)
      .where(eq(sec.collectionId, row.collectionId));
    try {
      return expectOne(
        await this.db
          .insert(sec)
          .values({ ...row, position: (last?.position ?? -1) + 1 })
          .returning(),
      );
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  async deleteCollection(workspaceId: string, projectId: string, collectionId: string): Promise<boolean> {
    const rows = await this.db
      .delete(c)
      .where(and(eq(c.id, collectionId), eq(c.workspaceId, workspaceId), eq(c.projectId, projectId)))
      .returning({ id: c.id });
    return rows.length > 0;
  }

  async deleteSection(workspaceId: string, sectionId: string): Promise<void> {
    await this.db.delete(sec).where(and(eq(sec.id, sectionId), eq(sec.workspaceId, workspaceId)));
  }
}
