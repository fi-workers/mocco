import { and, asc, eq } from 'drizzle-orm';

import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** The exact-match lookup key the broker resolves a step's `credential` request by
 * (the workspace scope is passed separately). */
export interface GrantMatch {
  repoId: string;
  pipeline: string;
  gateName: string;
  provider: string;
  role: string;
}

/** Data access for mocco_credential_grants — the workspace credential allowlist.
 * Every read/write is scoped by `workspace_id` (carried on each row), so a grant is
 * never resolved by id alone (ADR 0012). */
export class CredentialGrantRepo {
  constructor(private readonly db: Db) {}

  /** Insert a grant and return the created row. */
  async create(row: typeof schema.credentialGrants.$inferInsert) {
    return expectOne(await this.db.insert(schema.credentialGrants).values(row).returning());
  }

  /** A workspace's grants, oldest first. */
  async listByWorkspace(workspaceId: string) {
    return await this.db
      .select()
      .from(schema.credentialGrants)
      .where(eq(schema.credentialGrants.workspaceId, workspaceId))
      .orderBy(asc(schema.credentialGrants.createdAt));
  }

  /** A grant owned by the workspace, keyed by its own id — or throw
   * EntityNotFoundError for a foreign or unknown id. Direct workspace_id scoping. */
  async getByIdInWorkspace(workspaceId: string, grantId: string) {
    const rows = await this.db
      .select()
      .from(schema.credentialGrants)
      .where(and(eq(schema.credentialGrants.id, grantId), eq(schema.credentialGrants.workspaceId, workspaceId)));
    return getOrThrow(rows, `Credential grant ${grantId} was not found`);
  }

  /** Delete a grant owned by the workspace. Scoped by workspace_id. */
  async delete(workspaceId: string, grantId: string) {
    await this.db
      .delete(schema.credentialGrants)
      .where(and(eq(schema.credentialGrants.id, grantId), eq(schema.credentialGrants.workspaceId, workspaceId)));
  }

  /** The single grant matching the exact allowlist tuple within a workspace, or
   * `undefined` (a `find*` — never throws; the broker treats absence as DENY). The
   * unique index guarantees at most one row. */
  async findMatching(workspaceId: string, match: GrantMatch) {
    const rows = await this.db
      .select()
      .from(schema.credentialGrants)
      .where(
        and(
          eq(schema.credentialGrants.workspaceId, workspaceId),
          eq(schema.credentialGrants.repoId, match.repoId),
          eq(schema.credentialGrants.pipeline, match.pipeline),
          eq(schema.credentialGrants.gateName, match.gateName),
          eq(schema.credentialGrants.provider, match.provider),
          eq(schema.credentialGrants.role, match.role),
        ),
      );
    return rows[0];
  }
}
