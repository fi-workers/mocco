// Applies the committed drizzle migrations to DATABASE_URL — the Migrate workflow's step
// (.github/workflows/migrate.yml). It uses drizzle-orm's migrator, which keeps the same
// journal as drizzle-kit (drizzle.__drizzle_migrations), because the drizzle-kit CLI
// swallows the error behind its spinner. A failure here prints the driver's error code
// and message, and never the URL (which carries the password).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsFolder = path.join(root, 'packages', 'backend', 'src', 'infra', 'db', 'migrations');
const { hostname, port } = new URL(url);
console.log(`Migrating ${hostname}:${port || '5432'}`);

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder });
  const { rows } = await pool.query('select count(*)::int as applied from drizzle.__drizzle_migrations');
  console.log(`Done: ${rows[0].applied} migrations recorded`);
} catch (error) {
  const cause = error?.cause ?? error;
  const message = String(cause?.message ?? error).replaceAll(url, '<DATABASE_URL>');
  console.error(`Migration failed: ${cause?.code ?? error?.name ?? 'error'} ${message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
