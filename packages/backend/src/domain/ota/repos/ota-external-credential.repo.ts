import { and, asc, eq } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { OtaTool } from '@mocco/common/ota';

/** Data access for mocco_ota_external_credentials. Every query is scoped by `workspace_id`. */
export class OtaExternalCredentialRepo {
  constructor(private readonly db: Db) {}

  /** Insert a credential. Throws UniqueConstraintError when the name is taken in the workspace. */
  async create(row: typeof schema.otaExternalCredentials.$inferInsert) {
    try {
      return expectOne(await this.db.insert(schema.otaExternalCredentials).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /** A project's credentials, name-ordered. */
  async listByProject(workspaceId: string, projectId: string) {
    return await this.db
      .select()
      .from(schema.otaExternalCredentials)
      .where(
        and(
          eq(schema.otaExternalCredentials.workspaceId, workspaceId),
          eq(schema.otaExternalCredentials.projectId, projectId),
        ),
      )
      .orderBy(asc(schema.otaExternalCredentials.name));
  }

  /** A credential of the project — or throw EntityNotFoundError. */
  async getInProject(workspaceId: string, projectId: string, id: string) {
    const rows = await this.db
      .select()
      .from(schema.otaExternalCredentials)
      .where(
        and(
          eq(schema.otaExternalCredentials.id, id),
          eq(schema.otaExternalCredentials.workspaceId, workspaceId),
          eq(schema.otaExternalCredentials.projectId, projectId),
        ),
      );
    return getOrThrow(rows, `OTA credential ${id} was not found`);
  }

  /** The workspace's credential for a tool under a name (the broker's `role`), if any. */
  async findForIssue(workspaceId: string, tool: OtaTool, name: string) {
    const [row] = await this.db
      .select()
      .from(schema.otaExternalCredentials)
      .where(
        and(
          eq(schema.otaExternalCredentials.workspaceId, workspaceId),
          eq(schema.otaExternalCredentials.tool, tool),
          eq(schema.otaExternalCredentials.name, name),
        ),
      );
    return row;
  }

  /** Replace the sealed secret. Scoped by workspace. */
  async updateSecret(workspaceId: string, id: string, values: { secretSealed: string; secretFingerprint: string }) {
    return expectOne(
      await this.db
        .update(schema.otaExternalCredentials)
        .set({ ...values, rotatedAt: new Date() })
        .where(
          and(eq(schema.otaExternalCredentials.id, id), eq(schema.otaExternalCredentials.workspaceId, workspaceId)),
        )
        .returning(),
    );
  }

  async delete(workspaceId: string, id: string) {
    await this.db
      .delete(schema.otaExternalCredentials)
      .where(and(eq(schema.otaExternalCredentials.id, id), eq(schema.otaExternalCredentials.workspaceId, workspaceId)));
  }
}
