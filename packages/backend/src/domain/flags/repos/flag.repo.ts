import { and, asc, eq } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type FlagRow = typeof schema.flags.$inferSelect;

/** Data access for mocco_flags. Every query is scoped by `workspace_id`. */
export class FlagRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.flags.$inferInsert) {
    try {
      return expectOne(await this.db.insert(schema.flags).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  async setClientVisible(workspaceId: string, projectId: string, key: string, isClientVisible: boolean) {
    const [row] = await this.db
      .update(schema.flags)
      .set({ clientVisible: isClientVisible })
      .where(
        and(
          eq(schema.flags.workspaceId, workspaceId),
          eq(schema.flags.projectId, projectId),
          eq(schema.flags.key, key),
        ),
      )
      .returning();
    return row;
  }

  /** Change a flag's definition fields (`.mocco/flags.yml` syncs, #145). */
  async updateDefinition(
    workspaceId: string,
    projectId: string,
    key: string,
    values: Partial<Pick<FlagRow, 'description' | 'lifecycle' | 'variants' | 'clientVisible' | 'managedBy'>>,
  ) {
    const [row] = await this.db
      .update(schema.flags)
      .set(values)
      .where(
        and(
          eq(schema.flags.workspaceId, workspaceId),
          eq(schema.flags.projectId, projectId),
          eq(schema.flags.key, key),
        ),
      )
      .returning();
    return row;
  }

  async listByProject(workspaceId: string, projectId: string) {
    return await this.db
      .select()
      .from(schema.flags)
      .where(and(eq(schema.flags.workspaceId, workspaceId), eq(schema.flags.projectId, projectId)))
      .orderBy(asc(schema.flags.key));
  }
}
