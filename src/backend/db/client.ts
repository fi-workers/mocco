import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

/** Drizzle DB type (reused in the tRPC context etc.). Shared schema across node-postgres and pglite. */
export type Db = typeof db;

export * as schema from './schema';
