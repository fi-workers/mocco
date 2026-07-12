import { drizzle } from 'drizzle-orm/node-postgres';
import { type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';

import { getEnv } from '../config/env';

import * as schema from './schema';

const createDb = () => drizzle(new Pool({ connectionString: getEnv().DATABASE_URL }), { schema });

/**
 * Drizzle DB type (reused in service constructors, the tRPC context, etc.).
 * Driver-agnostic over the query-result HKT so the same type accepts both the
 * production node-postgres client and the pglite client used in tests.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const state: { db?: Db } = {};

/** Production DB — lazy (via getEnv) so builds don't need env; missing env fails loudly at first use. */
export function getDb(): Db {
  state.db ??= createDb();
  return state.db;
}

export * as schema from './schema';
