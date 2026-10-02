import { and, asc, eq } from 'drizzle-orm';

import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type TrustPolicyRow = typeof schema.otaTrustPolicies.$inferSelect;

/** Data access for mocco_ota_trust_policies. */
export class TrustPolicyRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.otaTrustPolicies.$inferInsert) {
    return expectOne(await this.db.insert(schema.otaTrustPolicies).values(row).returning());
  }

  async listByApp(workspaceId: string, appId: string) {
    return await this.db
      .select()
      .from(schema.otaTrustPolicies)
      .where(and(eq(schema.otaTrustPolicies.workspaceId, workspaceId), eq(schema.otaTrustPolicies.appId, appId)))
      .orderBy(asc(schema.otaTrustPolicies.createdAt));
  }

  /** The app's policies for one GitHub repository id (what an OIDC token can match). */
  async listForRepository(appId: string, repositoryId: bigint) {
    return await this.db
      .select()
      .from(schema.otaTrustPolicies)
      .where(and(eq(schema.otaTrustPolicies.appId, appId), eq(schema.otaTrustPolicies.repositoryId, repositoryId)))
      .orderBy(asc(schema.otaTrustPolicies.createdAt));
  }

  async getInApp(workspaceId: string, appId: string, id: string) {
    const rows = await this.db
      .select()
      .from(schema.otaTrustPolicies)
      .where(
        and(
          eq(schema.otaTrustPolicies.id, id),
          eq(schema.otaTrustPolicies.workspaceId, workspaceId),
          eq(schema.otaTrustPolicies.appId, appId),
        ),
      );
    return getOrThrow(rows, `Trust policy ${id} was not found`);
  }

  async delete(id: string) {
    await this.db.delete(schema.otaTrustPolicies).where(eq(schema.otaTrustPolicies.id, id));
  }
}
