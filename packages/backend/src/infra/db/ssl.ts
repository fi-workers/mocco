import { SUPABASE_ROOT_CA_2021 } from '@backend/infra/db/supabase-ca';

import type { ConnectionOptions } from 'node:tls';

const supabaseHostSuffixes = ['.supabase.com', '.supabase.co'];

// node-postgres lets these URL params replace the `ssl` object below, so they're dropped.
const urlSslParams = new Set(['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']);

export interface PgConnectionConfig {
  connectionString: string;
  ssl?: ConnectionOptions;
}

/**
 * node-postgres connection config that verifies a Supabase server's certificate (verify-full:
 * chain to the Supabase CA plus hostname). `caPem` is `POSTGRES_CA_CERT`; unset, the committed
 * Supabase Root 2021 CA is used, so a deploy without the env var still connects.
 * Non-Supabase hosts (local Postgres, CI) are returned unchanged.
 */
export function pgConnectionConfig(databaseUrl: string, caPem: string | undefined): PgConnectionConfig {
  if (!URL.canParse(databaseUrl)) {
    return { connectionString: databaseUrl };
  }
  const url = new URL(databaseUrl);
  if (supabaseHostSuffixes.every(suffix => !url.hostname.endsWith(suffix))) {
    return { connectionString: databaseUrl };
  }
  url.search = new URLSearchParams([...url.searchParams].filter(([key]) => !urlSslParams.has(key))).toString();
  return {
    connectionString: url.href,
    ssl: { ca: caPem ?? SUPABASE_ROOT_CA_2021, rejectUnauthorized: true },
  };
}
