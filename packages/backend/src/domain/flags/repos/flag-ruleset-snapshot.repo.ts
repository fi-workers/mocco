import { and, desc, eq } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_flag_ruleset_snapshots (insert-only). Scoped by `workspace_id`. */
export class FlagRulesetSnapshotRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.flagRulesetSnapshots.$inferInsert) {
    await this.db.insert(schema.flagRulesetSnapshots).values(row);
  }

  /** The environment's newest snapshot. */
  async latest(workspaceId: string, environmentId: string) {
    const [row] = await this.db
      .select()
      .from(schema.flagRulesetSnapshots)
      .where(
        and(
          eq(schema.flagRulesetSnapshots.workspaceId, workspaceId),
          eq(schema.flagRulesetSnapshots.environmentId, environmentId),
        ),
      )
      .orderBy(desc(schema.flagRulesetSnapshots.version))
      .limit(1);
    return row;
  }
}
