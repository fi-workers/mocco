import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import * as schema from '@backend/infra/db/schema';

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;

// Migrations folder (db/migrations) — reuse the production migrations to verify the real schema as-is.
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

export interface TestDbOptions {
  /** Called with every statement the db runs (migrations included), for tests that pin
   * how many queries a read takes. */
  onQuery?: (query: string) => void;
}

/**
 * Docker-free in-memory Postgres (WASM, PGlite) + Drizzle. Test-only.
 * Each instance is a fresh isolated DB, so creating a new one per test keeps state from mixing.
 */
export async function createTestDb(options: TestDbOptions = {}) {
  const client = new PGlite(); // in-memory (no path specified)
  const { onQuery } = options;
  const db = drizzle(client, {
    schema,
    ...(onQuery !== undefined && {
      logger: {
        logQuery: (query: string) => {
          onQuery(query);
        },
      },
    }),
  });
  await migrate(db, { migrationsFolder });
  return {
    db,
    schema,
    /** Call when the test finishes — release the WASM instance */
    async close() {
      await client.close();
    },
  };
}
