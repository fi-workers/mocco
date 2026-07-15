import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

// Docker-free PGlite (WASM Postgres) integration test. Each test gets a fresh isolated DB.
describe('auth schema (users/sessions/accounts/verifications)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it('user insert/select after migrations are applied', async () => {
    const [u] = await t.db.insert(t.schema.users).values({ email: 'andrea@example.com', name: 'andrea' }).returning();

    expect(u?.id).toBeTruthy();
    expect(u?.emailVerified).toBe(false);

    const rows = await t.db.select().from(t.schema.users);
    expect(rows).toHaveLength(1);
  });

  it('session references user and cascades on delete', async () => {
    const [u] = await t.db.insert(t.schema.users).values({ email: 'x@y.z' }).returning();
    await t.db.insert(t.schema.sessions).values({
      token: 'tok-1',
      expiresAt: new Date(Date.now() + 60_000),
      userId: u?.id ?? '',
    });

    expect(await t.db.select().from(t.schema.sessions)).toHaveLength(1);

    await t.db.delete(t.schema.users);
    expect(await t.db.select().from(t.schema.sessions)).toHaveLength(0); // onDelete: cascade
  });

  it('the DB is isolated per test (no data leaks from a prior test)', async () => {
    expect(await t.db.select().from(t.schema.users)).toHaveLength(0);
  });
});
