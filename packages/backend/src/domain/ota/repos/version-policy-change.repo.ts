import { and, desc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_ota_version_policy_changes (append-only). Scoped by `workspace_id`. */
export class VersionPolicyChangeRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.otaVersionPolicyChanges.$inferInsert) {
    return expectOne(await this.db.insert(schema.otaVersionPolicyChanges).values(row).returning());
  }

  /** The app's changes, newest first. */
  async listByApp(workspaceId: string, appId: string) {
    return await this.db
      .select()
      .from(schema.otaVersionPolicyChanges)
      .where(
        and(
          eq(schema.otaVersionPolicyChanges.workspaceId, workspaceId),
          eq(schema.otaVersionPolicyChanges.appId, appId),
        ),
      )
      .orderBy(desc(schema.otaVersionPolicyChanges.createdAt));
  }
}
