import { and, eq } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_ota_version_policies. Every query is scoped by `workspace_id`. */
export class VersionPolicyRepo {
  constructor(private readonly db: Db) {}

  /** The app's policy, if one was ever set. */
  async find(workspaceId: string, appId: string) {
    const [row] = await this.db
      .select()
      .from(schema.otaVersionPolicies)
      .where(and(eq(schema.otaVersionPolicies.workspaceId, workspaceId), eq(schema.otaVersionPolicies.appId, appId)));
    return row;
  }

  /** The app's policy with the app's store identifiers, by app id alone — for the
   * public version check, where the app id is the only (non-secret) key and nothing
   * workspace-scoped is returned. */
  async findForCheck(appId: string) {
    const [row] = await this.db
      .select({
        policy: schema.otaVersionPolicies,
        app: {
          platform: schema.projectApps.platform,
          bundleId: schema.projectApps.bundleId,
          storeAppId: schema.projectApps.storeAppId,
        },
      })
      .from(schema.otaVersionPolicies)
      .innerJoin(schema.projectApps, eq(schema.otaVersionPolicies.appId, schema.projectApps.id))
      .where(eq(schema.otaVersionPolicies.appId, appId));
    return row;
  }

  /** Create the first revision; undefined when another writer created it first. */
  async insertFirst(row: Omit<typeof schema.otaVersionPolicies.$inferInsert, 'revision'>) {
    const [created] = await this.db
      .insert(schema.otaVersionPolicies)
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
    values: Omit<typeof schema.otaVersionPolicies.$inferInsert, 'appId' | 'workspaceId' | 'projectId' | 'revision'>,
  ) {
    const [updated] = await this.db
      .update(schema.otaVersionPolicies)
      .set({ ...values, revision: expectedRevision + 1 })
      .where(
        and(
          eq(schema.otaVersionPolicies.workspaceId, workspaceId),
          eq(schema.otaVersionPolicies.appId, appId),
          eq(schema.otaVersionPolicies.revision, expectedRevision),
        ),
      )
      .returning();
    return updated;
  }
}
