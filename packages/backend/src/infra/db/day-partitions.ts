// Day partitions of a table range-partitioned by a timestamp (one partition per UTC day,
// `<parent>_pYYYYMMDD`). Plumbing for append-only time series that are dropped a day at a time
// instead of deleted row by row. DDL is built only from the parent name the caller passes as a
// constant and from dates formatted here.
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '@backend/infra/db/types';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PARENT_NAME = /^[a-z_]+$/;
const partitionsSchema = z.object({ rows: z.array(z.object({ name: z.string() })) });
/** Postgres raises check_violation (23514) for a row no partition accepts. */
const NO_PARTITION = '23514';
const DAY_MS = 86_400_000;

/** The UTC day (`YYYY-MM-DD`) a time falls on: the partition it belongs to. */
export const utcDayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** The UTC day `offset` days from `at`. */
export const utcDayFrom = (at: Date, offset: number): string => utcDayOf(new Date(at.getTime() + offset * DAY_MS));

function assertDay(day: string): void {
  if (!DAY.test(day)) {
    throw new Error(`not a day: ${day}`);
  }
}

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

/** Whether a write failed because no partition accepts its row. Callers validate their values
 * before writing, so a check violation from a partitioned insert means a missing day. */
export const isMissingPartition = (error: unknown): boolean => driverCode(error) === NO_PARTITION;

export class DayPartitions {
  private readonly pattern: RegExp;

  constructor(
    private readonly db: Db,
    private readonly parent: string,
  ) {
    if (!PARENT_NAME.test(parent)) {
      throw new Error(`not a table name: ${parent}`);
    }
    this.pattern = new RegExp(String.raw`^${parent}_p(\d{4})(\d{2})(\d{2})$`, 'u');
  }

  private nameOf(day: string): string {
    // eslint-disable-next-line sonarjs/null-dereference -- day is a string, never null
    return `${this.parent}_p${day.replaceAll('-', '')}`;
  }

  /** Create the partitions for these UTC days that don't exist yet. */
  async ensure(days: readonly string[]): Promise<void> {
    await days.reduce(async (previous, day) => {
      await previous;
      assertDay(day);
      const next = utcDayFrom(new Date(`${day}T00:00:00.000Z`), 1);
      await this.db.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS "${this.nameOf(day)}" PARTITION OF "${this.parent}" FOR VALUES FROM ('${day}') TO ('${next}')`,
        ),
      );
    }, Promise.resolve());
  }

  /** The UTC days that have a partition, oldest first. */
  async days(): Promise<string[]> {
    const result = await this.db.execute(sql`
      SELECT c.relname AS name FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = ${this.parent}`);
    return partitionsSchema
      .parse(result)
      .rows.flatMap(row => {
        const match = this.pattern.exec(row.name);
        return match === null ? [] : [`${match[1]}-${match[2]}-${match[3]}`];
      })
      .toSorted((a, b) => Date.parse(a) - Date.parse(b));
  }

  /** Drop a day's partition with all its rows. */
  async drop(day: string): Promise<void> {
    assertDay(day);
    await this.db.execute(sql.raw(`DROP TABLE IF EXISTS "${this.nameOf(day)}"`));
  }

  /** Run a write; if no partition accepts a row, create the days' partitions and run it once more.
   * Not inside a transaction: the failed statement would abort it. */
  async withPartitions<T>(days: readonly string[], write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (!isMissingPartition(error)) {
        throw error;
      }
      await this.ensure([...new Set(days)]);
      return await write();
    }
  }
}
