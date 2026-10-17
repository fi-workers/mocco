import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { pgConnectionConfig } from '@backend/infra/db/ssl';
import { SUPABASE_ROOT_CA_2021 } from '@backend/infra/db/supabase-ca';

const pooler = 'postgresql://postgres.ref:pw@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres';

describe('pgConnectionConfig', () => {
  it('verifies a Supabase host against the committed CA when no CA is configured', () => {
    expect(pgConnectionConfig(pooler, undefined)).toEqual({
      connectionString: pooler,
      ssl: { ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true },
    });
  });

  it('prefers the configured CA', () => {
    expect(pgConnectionConfig(pooler, 'pem').ssl?.ca).toBe('pem');
  });

  it('drops URL ssl params so node-postgres cannot replace the ssl object', () => {
    const config = pgConnectionConfig(`${pooler}?sslmode=require&uselibpqcompat=true&ssl=no-verify&x=1`, undefined);
    expect(config.connectionString).toBe(`${pooler}?x=1`);
    expect(config.ssl?.rejectUnauthorized).toBe(true);
  });

  it('covers the direct host (db.<ref>.supabase.co)', () => {
    expect(
      pgConnectionConfig('postgresql://postgres:pw@db.ref.supabase.co:5432/postgres', undefined).ssl
        ?.rejectUnauthorized,
    ).toBe(true);
  });

  it('leaves local Postgres unchanged', () => {
    const local = 'postgres://mocco:mocco@localhost:5432/mocco';
    expect(pgConnectionConfig(local, undefined)).toEqual({ connectionString: local });
  });

  it('does not treat a lookalike domain as Supabase', () => {
    const lookalike = 'postgresql://u:pw@evilsupabase.com:5432/postgres';
    expect(pgConnectionConfig(lookalike, undefined)).toEqual({ connectionString: lookalike });
  });

  it('keeps the in-code CA identical to supabase-ca.crt', async () => {
    const crt = await readFile(new URL('supabase-ca.crt', import.meta.url), 'utf8');
    expect(SUPABASE_ROOT_CA_2021).toBe(crt);
  });
});
