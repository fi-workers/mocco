import { and, eq, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_flag_configs. Every query is scoped by `workspace_id`. */
export class FlagConfigRepo {
  constructor(private readonly db: Db) {}

  /** Every flag of the environment with its definition. */
  async listForEnvironment(workspaceId: string, environmentId: string) {
    return await this.db
      .select({ config: schema.flagConfigs, flag: schema.flags })
      .from(schema.flagConfigs)
      .innerJoin(schema.flags, eq(schema.flagConfigs.flagId, schema.flags.id))
      .where(and(eq(schema.flagConfigs.workspaceId, workspaceId), eq(schema.flagConfigs.environmentId, environmentId)));
  }

  /** Every config in the project's environments. */
  async listForProject(workspaceId: string, projectId: string) {
    return await this.db
      .select({ config: schema.flagConfigs })
      .from(schema.flagConfigs)
      .innerJoin(schema.flagEnvironments, eq(schema.flagConfigs.environmentId, schema.flagEnvironments.id))
      .where(and(eq(schema.flagConfigs.workspaceId, workspaceId), eq(schema.flagEnvironments.projectId, projectId)));
  }

  /** Write the changed configs (a new salt only on insert). */
  async upsert(rows: (typeof schema.flagConfigs.$inferInsert)[]) {
    if (rows.length === 0) {
      return;
    }
    await this.db
      .insert(schema.flagConfigs)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.flagConfigs.environmentId, schema.flagConfigs.flagId],
        set: {
          enabled: sql`excluded.enabled`,
          killed: sql`excluded.killed`,
          defaultVariant: sql`excluded.default_variant`,
          offVariant: sql`excluded.off_variant`,
          rules: sql`excluded.rules`,
          rollout: sql`excluded.rollout`,
          version: sql`excluded.version`,
        },
      });
  }
}
