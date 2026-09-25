import { and, eq } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_app_version_policies. Every query is scoped by `workspace_id`. */
export class AppVersionPolicyRepo {
  constructor(private readonly db: Db) {}

  /** The app's policy, if one was ever set. */
  async find(workspaceId: string, appId: string) {
    const [row] = await this.db
      .select()
      .from(schema.appVersionPolicies)
      .where(and(eq(schema.appVersionPolicies.workspaceId, workspaceId), eq(schema.appVersionPolicies.appId, appId)));
    return row;
  }

  /** The app's policy by id alone — for the public version check, where the app id is
   * the only (non-secret) key and nothing workspace-scoped is revealed. */
  async findByAppId(appId: string) {
    const [row] = await this.db
      .select()
      .from(schema.appVersionPolicies)
      .where(eq(schema.appVersionPolicies.appId, appId));
    return row;
  }

  /** Create the first revision; undefined when another writer created it first. */
  async insertFirst(row: Omit<typeof schema.appVersionPolicies.$inferInsert, 'revision'>) {
    const [created] = await this.db
      .insert(schema.appVersionPolicies)
      .values({ ...row, revision: 1 })
      .onConflictDoNothing()
      .returning();
    return created;
  }

  /** Write the next revision ONLY if the stored revision is still `expectedRevision`
   * (optimistic concurrency); undefined when it moved. */
  async updateIfRevision(
    workspaceId: string,
    appId: string,
    expectedRevision: number,
    values: Omit<typeof schema.appVersionPolicies.$inferInsert, 'appId' | 'workspaceId' | 'projectId' | 'revision'>,
  ) {
    const [updated] = await this.db
      .update(schema.appVersionPolicies)
      .set({ ...values, revision: expectedRevision + 1 })
      .where(
        and(
          eq(schema.appVersionPolicies.workspaceId, workspaceId),
          eq(schema.appVersionPolicies.appId, appId),
          eq(schema.appVersionPolicies.revision, expectedRevision),
        ),
      )
      .returning();
    return updated;
  }
}
