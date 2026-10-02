import { and, asc, eq } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type OtaAppRow = typeof schema.otaApps.$inferSelect;

/** Data access for mocco_ota_apps. Reads are scoped by workspace (and project). */
export class OtaAppRepo {
  constructor(private readonly db: Db) {}

  /** Insert an app. Throws UniqueConstraintError when the project app already has one. */
  async insert(row: typeof schema.otaApps.$inferInsert) {
    try {
      return expectOne(await this.db.insert(schema.otaApps).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  async listByProject(workspaceId: string, projectId: string) {
    return await this.db
      .select()
      .from(schema.otaApps)
      .where(and(eq(schema.otaApps.workspaceId, workspaceId), eq(schema.otaApps.projectId, projectId)))
      .orderBy(asc(schema.otaApps.createdAt));
  }

  /** An app of the project — or throw EntityNotFoundError. */
  async getInProject(workspaceId: string, projectId: string, id: string) {
    const rows = await this.db
      .select()
      .from(schema.otaApps)
      .where(
        and(
          eq(schema.otaApps.id, id),
          eq(schema.otaApps.workspaceId, workspaceId),
          eq(schema.otaApps.projectId, projectId),
        ),
      );
    return getOrThrow(rows, `OTA app ${id} was not found`);
  }

  /** An app by id alone — only for the public manifest and upload surfaces, which are keyed by app id. */
  async findById(id: string) {
    const [row] = await this.db.select().from(schema.otaApps).where(eq(schema.otaApps.id, id));
    return row;
  }
}
