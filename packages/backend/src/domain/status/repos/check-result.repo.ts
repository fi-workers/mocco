import { sql } from 'drizzle-orm';
import { z } from 'zod';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type CheckResultRow = typeof schema.statusCheckResults.$inferSelect;

const r = schema.statusCheckResults;
const PARENT = 'mocco_status_check_results';
/** A day partition's name: the parent and the UTC day, `mocco_status_check_results_p20261005`. */
const PARTITION = /^mocco_status_check_results_p(\d{4})(\d{2})(\d{2})$/;
const partitionsSchema = z.object({ rows: z.array(z.object({ name: z.string() })) });
/** Postgres raises check_violation (23514) for a row no partition accepts. */
const NO_PARTITION = '23514';

/** The UTC day (`YYYY-MM-DD`) a time falls on: the partition it belongs to. */
export const utcDayOf = (at: Date): string => at.toISOString().slice(0, 10);
// eslint-disable-next-line sonarjs/null-dereference -- day is a string, never null
const partitionName = (day: string): string => `${PARENT}_p${day.replaceAll('-', '')}`;
const nextDay = (day: string): string => utcDayOf(new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000));

function driverCode(error: unknown): unknown {
  let current: unknown = error;
  while (current instanceof Error) {
    const { code } = current as Error & { code?: unknown };
    if (code !== undefined) {
      return code;
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * Data access for mocco_status_check_results, the day-partitioned raw results, and its
 * partitions. Partition DDL is built only from dates this repo formats itself.
 */
export class CheckResultRepo {
  constructor(private readonly db: Db) {}

  /**
   * Insert results, skipping any already stored for the same (monitor, round, location), and
   * return the lease ids actually inserted. A day without a partition yet (the job hasn't run
   * since the migration) gets one, and the insert is retried once.
   */
  async insertNew(rows: readonly (typeof r.$inferInsert)[]): Promise<string[]> {
    if (rows.length === 0) {
      return [];
    }
    const insert = async () => {
      const inserted = await this.db
        .insert(r)
        .values([...rows])
        .onConflictDoNothing()
        .returning({ leaseId: r.leaseId });
      return inserted.map(row => row.leaseId);
    };
    try {
      return await insert();
    } catch (error) {
      if (driverCode(error) !== NO_PARTITION) {
        throw error;
      }
      await this.ensurePartitions([...new Set(rows.map(row => utcDayOf(row.roundAt)))]);
      return await insert();
    }
  }

  /** Create the partitions for these UTC days (`YYYY-MM-DD`) that don't exist yet. */
  async ensurePartitions(days: readonly string[]): Promise<void> {
    await days.reduce(async (previous, day) => {
      await previous;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new Error(`not a day: ${day}`);
      }
      await this.db.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS "${partitionName(day)}" PARTITION OF "${PARENT}" FOR VALUES FROM ('${day}') TO ('${nextDay(day)}')`,
        ),
      );
    }, Promise.resolve());
  }

  /** The UTC days that have a partition, oldest first. */
  async partitionDays(): Promise<string[]> {
    const result = await this.db.execute(sql`
      SELECT c.relname AS name FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = ${PARENT}`);
    return partitionsSchema
      .parse(result)
      .rows.flatMap(row => {
        const match = PARTITION.exec(row.name);
        return match === null ? [] : [`${match[1]}-${match[2]}-${match[3]}`];
      })
      .toSorted((a, b) => Date.parse(a) - Date.parse(b));
  }

  /** Drop a day's partition with all its rows. */
  async dropPartition(day: string): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new Error(`not a day: ${day}`);
    }
    await this.db.execute(sql.raw(`DROP TABLE IF EXISTS "${partitionName(day)}"`));
  }
}
