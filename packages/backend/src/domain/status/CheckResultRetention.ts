// Day partitions of the raw check results (#150). mocco_status_check_results is partitioned by
// UTC day on round_at; this keeps the next few days' partitions created and drops whole days
// past retention, so old results go without a DELETE. Runs as the hourly `status.retention` job.
import { CheckResultRepo, utcDayOf } from '@backend/domain/status/repos/check-result.repo';

import type { Db } from '@backend/infra/db/types';

export const CheckResultRetentionPolicy = {
  /** Raw results are kept this many days (today included) and then dropped by partition. */
  keepDays: 14,
  /** Partitions exist for today and this many days ahead. */
  daysAhead: 2,
} as const;

const DAY_MS = 86_400_000;

export class CheckResultRetention {
  constructor(private readonly deps: { db: Db }) {}

  /** Create today's and the coming days' partitions and drop the ones past retention. */
  async run(now: Date): Promise<{ created: string[]; dropped: string[] }> {
    const results = new CheckResultRepo(this.deps.db);
    const existing = new Set(await results.partitionDays());
    const wanted = Array.from({ length: CheckResultRetentionPolicy.daysAhead + 1 }, (_, offset) =>
      utcDayOf(new Date(now.getTime() + offset * DAY_MS)),
    );
    const created = wanted.filter(day => !existing.has(day));
    await results.ensurePartitions(created);
    const oldestKept = utcDayOf(new Date(now.getTime() - (CheckResultRetentionPolicy.keepDays - 1) * DAY_MS));
    // YYYY-MM-DD compares as text in date order.
    const dropped = [...existing].filter(day => day < oldestKept);
    await dropped.reduce(async (previous, day) => {
      await previous;
      await results.dropPartition(day);
    }, Promise.resolve());
    return { created, dropped };
  }
}
