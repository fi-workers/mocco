import { and, asc, eq } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_project_apps. Every read/write is scoped by workspace AND project. */
export class ProjectAppRepo {
  constructor(private readonly db: Db) {}

  /** Insert an app. Throws UniqueConstraintError when the project already has the
   * same platform + bundle id. */
  async create(row: typeof schema.projectApps.$inferInsert) {
    try {
      return expectOne(await this.db.insert(schema.projectApps).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /** A project's apps, name-ordered. */
  async listByProject(workspaceId: string, projectId: string) {
    return await this.db
      .select()
      .from(schema.projectApps)
      .where(and(eq(schema.projectApps.workspaceId, workspaceId), eq(schema.projectApps.projectId, projectId)))
      .orderBy(asc(schema.projectApps.name));
  }

  /** An app of the project — or throw EntityNotFoundError for a foreign or unknown id. */
  async getInProject(workspaceId: string, projectId: string, appId: string) {
    const rows = await this.db
      .select()
      .from(schema.projectApps)
      .where(
        and(
          eq(schema.projectApps.id, appId),
          eq(schema.projectApps.workspaceId, workspaceId),
          eq(schema.projectApps.projectId, projectId),
        ),
      );
    return getOrThrow(rows, `App ${appId} was not found`);
  }

  /** Delete an app of the project. Scoped by workspace and project. */
  async delete(workspaceId: string, projectId: string, appId: string) {
    await this.db
      .delete(schema.projectApps)
      .where(
        and(
          eq(schema.projectApps.id, appId),
          eq(schema.projectApps.workspaceId, workspaceId),
          eq(schema.projectApps.projectId, projectId),
        ),
      );
  }
}
