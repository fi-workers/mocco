import { and, eq } from 'drizzle-orm';

import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { Provider } from '@mocco/common/integration';

/** Data access for mocco_provider_connections. Tenant isolation lives here: every
 * lookup is scoped by workspaceId. */
export class ProviderConnectionRepo {
  constructor(private readonly db: Db) {}

  /** A connection owned by the workspace, or throw EntityNotFoundError. */
  async getById(workspaceId: string, connectionId: string) {
    return getOrThrow(
      await this.db
        .select()
        .from(schema.providerConnections)
        .where(
          and(eq(schema.providerConnections.id, connectionId), eq(schema.providerConnections.workspaceId, workspaceId)),
        ),
      `Connection ${connectionId} was not found`,
    );
  }

  /** Global lookup by the unique (provider, external_account_id) key — the ONE
   * intentionally un-workspace-scoped read, used to enforce that an installation
   * stays with a single workspace before an upsert could reassign it. */
  async findByExternalAccount(provider: Provider, externalAccountId: string) {
    const [row] = await this.db
      .select()
      .from(schema.providerConnections)
      .where(
        and(
          eq(schema.providerConnections.provider, provider),
          eq(schema.providerConnections.externalAccountId, externalAccountId),
        ),
      );
    return row;
  }

  async findByWorkspace(workspaceId: string) {
    return await this.db
      .select()
      .from(schema.providerConnections)
      .where(eq(schema.providerConnections.workspaceId, workspaceId));
  }

  /** Upsert keyed on (provider, external_account_id). */
  async upsert(workspaceId: string, provider: Provider, input: { externalAccountId: string; accountLogin: string }) {
    return expectOne(
      await this.db
        .insert(schema.providerConnections)
        .values({
          workspaceId,
          provider,
          externalAccountId: input.externalAccountId,
          accountLogin: input.accountLogin,
        })
        .onConflictDoUpdate({
          target: [schema.providerConnections.provider, schema.providerConnections.externalAccountId],
          set: { workspaceId, accountLogin: input.accountLogin, status: 'active' },
        })
        .returning(),
    );
  }
}
