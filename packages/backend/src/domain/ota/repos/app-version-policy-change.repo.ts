import { and, desc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_app_version_policy_changes (append-only). Scoped by `workspace_id`. */
export class AppVersionPolicyChangeRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.appVersionPolicyChanges.$inferInsert) {
    return expectOne(await this.db.insert(schema.appVersionPolicyChanges).values(row).returning());
  }

  /** The app's changes, newest first. */
  async listByApp(workspaceId: string, appId: string) {
    return await this.db
      .select()
      .from(schema.appVersionPolicyChanges)
      .where(
        and(
          eq(schema.appVersionPolicyChanges.workspaceId, workspaceId),
          eq(schema.appVersionPolicyChanges.appId, appId),
        ),
      )
      .orderBy(desc(schema.appVersionPolicyChanges.createdAt));
  }
}
