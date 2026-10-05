import { EntityNotFoundError } from '@backend/infra/db/errors';

/** First row, or throw EntityNotFoundError — for a lookup that may legitimately miss. */
export function getOrThrow<T>(rows: T[], message: string): T {
  const [row] = rows;
  if (row === undefined) {
    throw new EntityNotFoundError(message);
  }
  return row;
}

/** First row, or throw a plain invariant Error — for a single-row write guaranteed to
 * return one row (insert/upsert … returning). NOT a not-found; it can't legitimately happen. */
export function expectOne<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected one row from a single-row write');
  }
  return row;
}

/** Run `write` over `rows` in batches of `size`, one after another: a multi-row insert binds a
 * parameter per column and row, and Postgres allows 65,535 per statement. */
export async function inBatches<T>(rows: readonly T[], size: number, write: (batch: T[]) => Promise<unknown>) {
  const batches = Array.from({ length: Math.ceil(rows.length / size) }, (_, n) => rows.slice(n * size, (n + 1) * size));
  await batches.reduce(async (previous, batch) => {
    await previous;
    await write(batch);
  }, Promise.resolve());
}
