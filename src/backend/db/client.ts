import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { getEnv } from '../config/env';

import * as schema from './schema';

const createDb = () => drizzle(new Pool({ connectionString: getEnv().DATABASE_URL }), { schema });

/** Drizzle DB type (reused in the tRPC context etc.). Shared schema across node-postgres and pglite. */
export type Db = ReturnType<typeof createDb>;

const state: { db?: Db } = {};

/** Production DB — lazy (via getEnv) so builds don't need env; missing env fails loudly at first use. */
export function getDb(): Db {
  state.db ??= createDb();
  return state.db;
}

export * as schema from './schema';
