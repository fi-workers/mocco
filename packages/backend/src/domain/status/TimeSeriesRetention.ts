// Day partitions of the status time series (#150): the raw check results and the round verdicts
// are both partitioned by UTC day on round_at. This keeps the next few days' partitions created
// and drops whole days past each table's retention, so old rows go without a DELETE. It also
// deletes hourly rollups past theirs (#152). Runs as the hourly `status.retention` job.
import { CheckResultRepo } from '@backend/domain/status/repos/check-result.repo';
import { RollupHourlyRepo } from '@backend/domain/status/repos/rollup-hourly.repo';
import { RoundVerdictRepo } from '@backend/domain/status/repos/round-verdict.repo';
import { RollupPolicy } from '@backend/domain/status/RollupService';
import { DAY_MS } from '@backend/domain/status/uptime';
import { utcDayFrom } from '@backend/infra/db/day-partitions';

import type { DayPartitions } from '@backend/infra/db/day-partitions';
import type { Db } from '@backend/infra/db/types';

export const TimeSeriesRetentionPolicy = {
  /** Raw results are kept this many days (today included) and then dropped by partition, unless
   * `STATUS_RAW_RETENTION_DAYS` says otherwise. Nothing reads them after their round closes:
   * rollups come from the verdicts and the state changes. */
  checkResultDays: 14,
  /** Round verdicts are kept this many days; state changes, kept forever, record downtime. */
  roundVerdictDays: 30,
  /** Partitions exist for today and this many days ahead. */
  daysAhead: 2,
} as const;

/** Create the wanted days' partitions and drop the ones past `keepDays`. */
async function maintain(
  partitions: DayPartitions,
  now: Date,
  keepDays: number,
): Promise<{ created: string[]; dropped: string[] }> {
  const existing = new Set(await partitions.days());
  const wanted = Array.from({ length: TimeSeriesRetentionPolicy.daysAhead + 1 }, (_, offset) =>
    utcDayFrom(now, offset),
  );
  const created = wanted.filter(day => !existing.has(day));
  await partitions.ensure(created);
  const oldestKept = utcDayFrom(now, -(keepDays - 1));
  // YYYY-MM-DD compares as text in date order.
  const dropped = [...existing].filter(day => day < oldestKept);
  await dropped.reduce(async (previous, day) => {
    await previous;
    await partitions.drop(day);
  }, Promise.resolve());
  return { created, dropped };
}

export class TimeSeriesRetention {
  constructor(private readonly deps: { db: Db; checkResultDays?: number }) {}

  async run(now: Date) {
    return {
      checkResults: await maintain(
        new CheckResultRepo(this.deps.db).partitions,
        now,
        this.deps.checkResultDays ?? TimeSeriesRetentionPolicy.checkResultDays,
      ),
      roundVerdicts: await maintain(
        new RoundVerdictRepo(this.deps.db).partitions,
        now,
        TimeSeriesRetentionPolicy.roundVerdictDays,
      ),
      hourlyRollupsDeleted: await new RollupHourlyRepo(this.deps.db).deleteBefore(
        new Date(now.getTime() - RollupPolicy.hourlyRetentionDays * DAY_MS),
      ),
    };
  }
}
