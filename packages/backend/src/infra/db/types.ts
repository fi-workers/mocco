import type * as schema from '@backend/infra/db/schema';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/** A DB handle broad enough for both the prod node-postgres db and the pglite test db
 * (both carry `typeof schema`); client.ts's concrete `Db` is node-postgres-only. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
