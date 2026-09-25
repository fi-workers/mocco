import { and, asc, eq, isNull } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_projects. Every read/write is scoped by `workspace_id` — a
 * project is never resolved by id alone. */
export class ProjectRepo {
  constructor(private readonly db: Db) {}

  /** Insert a project. Throws UniqueConstraintError when the handle is taken in the workspace. */
  async create(row: typeof schema.projects.$inferInsert) {
    try {
      return expectOne(await this.db.insert(schema.projects).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /** A workspace's projects, name-ordered; archived ones only when asked. */
  async listByWorkspace(workspaceId: string, { includeArchived }: { includeArchived: boolean }) {
    return await this.db
      .select()
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.workspaceId, workspaceId),
          includeArchived ? undefined : isNull(schema.projects.archivedAt),
        ),
      )
      .orderBy(asc(schema.projects.name));
  }

  /** A project owned by the workspace — or throw EntityNotFoundError for a foreign or unknown id. */
  async getByIdInWorkspace(workspaceId: string, projectId: string) {
    const rows = await this.db
      .select()
      .from(schema.projects)
      .where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, workspaceId)));
    return getOrThrow(rows, `Project ${projectId} was not found`);
  }

  /** Update a project owned by the workspace. Throws UniqueConstraintError on a taken handle. */
  async update(
    workspaceId: string,
    projectId: string,
    values: Partial<Pick<typeof schema.projects.$inferInsert, 'name' | 'handle' | 'defaultLocale' | 'archivedAt'>>,
  ) {
    try {
      return expectOne(
        await this.db
          .update(schema.projects)
          .set(values)
          .where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, workspaceId)))
          .returning(),
      );
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }
}
