import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { inject } from 'vitest';

import * as schema from '@backend/infra/db/schema';

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;

// Migrations folder (db/migrations) — reuse the production migrations to verify the real schema as-is.
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

declare module 'vitest' {
  export interface ProvidedContext {
    /** Path to the migrated template's data directory (a tar), written once per run by the global setup. */
    pgliteTemplatePath: string;
  }
}

/**
 * A fresh PGlite with every real migration applied, dumped as an uncompressed tar.
 * The global setup (`pglite-global-setup.ts`) runs this once per `vitest run`.
 */
export async function buildMigratedTemplate() {
  const client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder });
  const dataDir = await client.dumpDataDir('none');
  await client.close();
  return dataDir;
}

// Read once per test file (vitest isolates modules per file), then reused by every createTestDb in it.
const cache: { template?: Promise<Blob> } = {};
const loadTemplate = async () => {
  const path = inject('pgliteTemplatePath');
  if (!path) {
    throw new Error('createTestDb needs the pglite global setup (packages/backend/vitest.config.ts → globalSetup)');
  }
  return new Blob([await readFile(path)]);
};

/**
 * Docker-free in-memory Postgres (WASM, PGlite) + Drizzle. Test-only.
 * Each instance is a fresh isolated DB, so creating a new one per test keeps state from mixing.
 * It boots from the run's migrated template instead of migrating again: the same schema
 * (the template is built from the real migrations every run) for about a fifth of the CPU,
 * which keeps beforeEach hooks well inside their timeout on a loaded machine.
 */
export async function createTestDb() {
  cache.template ??= loadTemplate();
  const client = await PGlite.create({ loadDataDir: await cache.template });
  const db = drizzle(client, { schema });
  return {
    db,
    schema,
    /** Call when the test finishes — release the WASM instance */
    async close() {
      await client.close();
    },
  };
}
