import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { getEnv } from '../config/env';

import * as schema from './schema';

// max:1 — one connection per warm serverless instance. Supabase's pooler caps
// concurrent clients (session mode: ~15), and an unbounded Pool (pg default max 10)
// across many concurrent lambdas exhausts it (EMAXCONNSESSION). Point DATABASE_URL
// at the transaction pooler (:6543) in serverless. Local/tests: 1 is plenty.
const createDb = () => drizzle(new Pool({ connectionString: getEnv().DATABASE_URL, max: 1 }), { schema });

/** Drizzle DB type (reused in the tRPC context etc.). Shared schema across node-postgres and pglite. */
export type Db = ReturnType<typeof createDb>;

const state: { db?: Db } = {};

/** Production DB — lazy (via getEnv) so builds don't need env; missing env fails loudly at first use. */
export function getDb(): Db {
  state.db ??= createDb();
  return state.db;
}

export * as schema from './schema';
