import { and, asc, eq, sql } from 'drizzle-orm';

import { AdvisoryLockNamespaces } from '@backend/infra/db/advisory-locks';
import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { GateRequirements } from '@mocco/common/governance';

export type FlagEnvironmentRow = typeof schema.flagEnvironments.$inferSelect;

/** Data access for mocco_flag_environments. Every query is scoped by `workspace_id`. */
export class FlagEnvironmentRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.flagEnvironments.$inferInsert) {
    try {
      return expectOne(await this.db.insert(schema.flagEnvironments).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  async listByProject(workspaceId: string, projectId: string) {
    return await this.db
      .select()
      .from(schema.flagEnvironments)
      .where(
        and(eq(schema.flagEnvironments.workspaceId, workspaceId), eq(schema.flagEnvironments.projectId, projectId)),
      )
      .orderBy(asc(schema.flagEnvironments.createdAt));
  }

  /** The project's environments in lock order (by id), so transactions that lock
   * several environments always take the locks in the same order and can't deadlock. */
  async listByProjectInLockOrder(workspaceId: string, projectId: string) {
    return await this.db
      .select()
      .from(schema.flagEnvironments)
      .where(
        and(eq(schema.flagEnvironments.workspaceId, workspaceId), eq(schema.flagEnvironments.projectId, projectId)),
      )
      .orderBy(asc(schema.flagEnvironments.id));
  }

  async find(workspaceId: string, projectId: string, environmentId: string) {
    const [row] = await this.db
      .select()
      .from(schema.flagEnvironments)
      .where(
        and(
          eq(schema.flagEnvironments.workspaceId, workspaceId),
          eq(schema.flagEnvironments.projectId, projectId),
          eq(schema.flagEnvironments.id, environmentId),
        ),
      );
    return row;
  }

  /** An environment by id alone (no project filter, no lock). */
  async byId(workspaceId: string, environmentId: string) {
    const [row] = await this.db
      .select()
      .from(schema.flagEnvironments)
      .where(and(eq(schema.flagEnvironments.workspaceId, workspaceId), eq(schema.flagEnvironments.id, environmentId)));
    return row;
  }

  async setChangeGate(workspaceId: string, environmentId: string, changeGate: GateRequirements | null) {
    await this.db
      .update(schema.flagEnvironments)
      .set({ changeGate })
      .where(and(eq(schema.flagEnvironments.workspaceId, workspaceId), eq(schema.flagEnvironments.id, environmentId)));
  }

  async setKillRoles(workspaceId: string, environmentId: string, killRoles: string[]) {
    await this.db
      .update(schema.flagEnvironments)
      .set({ killRoles })
      .where(and(eq(schema.flagEnvironments.workspaceId, workspaceId), eq(schema.flagEnvironments.id, environmentId)));
  }

  async setLinkedRepo(workspaceId: string, environmentId: string, linkedRepoId: string | null) {
    await this.db
      .update(schema.flagEnvironments)
      .set({ linkedRepoId })
      .where(and(eq(schema.flagEnvironments.workspaceId, workspaceId), eq(schema.flagEnvironments.id, environmentId)));
  }

  /** Take the environment's publish lock for the rest of the transaction and read its
   * current version. Call inside a transaction only. */
  async lockForPublish(workspaceId: string, environmentId: string) {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(${AdvisoryLockNamespaces.flagEnvironment}, hashtext(${environmentId}))`,
    );
    const [row] = await this.db
      .select()
      .from(schema.flagEnvironments)
      .where(and(eq(schema.flagEnvironments.workspaceId, workspaceId), eq(schema.flagEnvironments.id, environmentId)));
    return row;
  }

  async setVersion(workspaceId: string, environmentId: string, version: number) {
    await this.db
      .update(schema.flagEnvironments)
      .set({ currentVersion: version })
      .where(and(eq(schema.flagEnvironments.workspaceId, workspaceId), eq(schema.flagEnvironments.id, environmentId)));
  }
}
