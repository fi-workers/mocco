import { and, eq, gte, max, sql, sum } from 'drizzle-orm';
import { z } from 'zod';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type RollupRow = typeof schema.flagEvalRollups.$inferInsert;

const r = schema.flagEvalRollups;
const pruneCountSchema = z.object({ rows: z.array(z.object({ count: z.coerce.number() })) });
const env = schema.flagEnvironments;

/** Data access for mocco_flag_eval_rollups (evaluation telemetry). */
export class FlagEvalRollupRepo {
  constructor(private readonly db: Db) {}

  /** Add counts to their hourly buckets (one statement; rows must be unique per bucket). */
  async addCounts(rows: RollupRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.db
      .insert(r)
      .values(rows)
      .onConflictDoUpdate({
        target: [r.environmentId, r.flagKey, r.variant, r.bucketHour],
        set: {
          count: sql`${r.count} + excluded.count`,
          lastSeenAt: sql`greatest(${r.lastSeenAt}, excluded.last_seen_at)`,
        },
      });
  }

  /** When each flag of every project was last evaluated in any of its environments. */
  async lastSeenByFlag(): Promise<{ projectId: string; flagKey: string; lastSeenAt: Date }[]> {
    const rows = await this.db
      .select({ projectId: env.projectId, flagKey: r.flagKey, lastSeenAt: max(r.lastSeenAt) })
      .from(r)
      .innerJoin(env, and(eq(env.id, r.environmentId), eq(env.workspaceId, r.workspaceId)))
      .groupBy(env.projectId, r.flagKey);
    return rows.flatMap(row => (row.lastSeenAt === null ? [] : [{ ...row, lastSeenAt: row.lastSeenAt }]));
  }

  /** A project's evaluations since `since`, per flag and environment, with the last time seen. */
  async usage(workspaceId: string, projectId: string, since: Date) {
    const rows = await this.db
      .select({
        environmentId: r.environmentId,
        flagKey: r.flagKey,
        evaluations: sum(r.count).mapWith(Number),
        lastSeenAt: max(r.lastSeenAt),
      })
      .from(r)
      .innerJoin(env, and(eq(env.id, r.environmentId), eq(env.workspaceId, r.workspaceId)))
      .where(and(eq(r.workspaceId, workspaceId), eq(env.projectId, projectId), gte(r.bucketHour, since)))
      .groupBy(r.environmentId, r.flagKey);
    return rows.map(row => ({ ...row, evaluations: row.evaluations ?? 0 }));
  }

  /** Drop buckets older than `before`, keeping each flag's newest per environment (the
   * "last evaluated" record). Returns how many were removed. */
  async prune(before: Date): Promise<number> {
    const result = await this.db.execute(sql`
      WITH removed AS (
        DELETE FROM ${r} AS old
        WHERE old.bucket_hour < ${before}
          AND old.bucket_hour < (
            SELECT max(newest.bucket_hour) FROM ${r} AS newest
            WHERE newest.environment_id = old.environment_id AND newest.flag_key = old.flag_key
          )
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM removed`);
    const [row] = pruneCountSchema.parse(result).rows;
    return row?.count ?? 0;
  }
}
