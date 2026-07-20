import { eq, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_commit_configs — a re-snapshot of a commit's parsed
 * `.mocco/config.yml` overwrites the prior row rather than versioning it. */
export class CommitConfigRepo {
  constructor(private readonly db: Db) {}

  /** Upsert keyed on commit_id: a repeated snapshot for the same commit overwrites. */
  async upsert(row: typeof schema.commitConfigs.$inferInsert): Promise<void> {
    await this.db
      .insert(schema.commitConfigs)
      .values(row)
      .onConflictDoUpdate({
        target: schema.commitConfigs.commitId,
        set: {
          present: row.present,
          rawYaml: row.rawYaml,
          parsedJson: row.parsedJson,
          valid: row.valid,
          validationErrors: row.validationErrors,
          // re-snapshot bumps the timestamp to the DB clock (a caller-passed syncedAt is intentionally ignored on overwrite)
          syncedAt: sql`now()`,
        },
      });
  }

  async findByCommitId(commitId: string) {
    const [row] = await this.db.select().from(schema.commitConfigs).where(eq(schema.commitConfigs.commitId, commitId));
    return row;
  }
}
