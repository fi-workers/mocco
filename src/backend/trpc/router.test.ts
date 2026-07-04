import { createTestProvider, setProviderForTesting, type Provider } from '../auth/testing';
import { createTestDb, type TestDb } from '../db/testing/pglite';

import { appRouter } from './router';

import type { Context } from './trpc';
import type { Db } from '../db/client';

// Full-stack tRPC tests on pglite: real migrations + real provider + real router.
describe('tRPC workspace router on pglite', () => {
  let t: TestDb;
  let provider: Provider;

  const signUpHeaders = async (email: string) => {
    const { headers } = await provider.api.signUpEmail({
      body: { email, password: 'fixture-password-1', name: 'fixture-user' },
      returnHeaders: true,
    });
    return new Headers({ cookie: headers.get('set-cookie') ?? '' });
  };

  const caller = (headers: Headers, session: Context['session']) =>
    appRouter.createCaller({ db: t.db as unknown as Db, session, headers });

  const signedInCaller = async (email: string) => {
    const headers = await signUpHeaders(email);
    const session = await provider.api.getSession({ headers });
    return caller(headers, session);
  };

  beforeEach(async () => {
    t = await createTestDb();
    provider = createTestProvider(t.db, { secret: 'test-secret-not-for-prod' });
    setProviderForTesting(provider);
  });
  afterEach(async () => {
    setProviderForTesting(undefined);
    await t.close();
  });

  it('unauthenticated calls are UNAUTHORIZED', async () => {
    const anonymous = caller(new Headers(), null);
    await expect(anonymous.workspace.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('create → list → active round-trip', async () => {
    const api = await signedInCaller('owner@example.com');

    const ws = await api.workspace.create({ name: 'Acme Lab', slug: 'acme-lab' });
    expect(ws.slug).toBe('acme-lab');

    const all = await api.workspace.list();
    expect(all).toHaveLength(1);

    const active = await api.workspace.active();
    expect(active?.id).toBe(ws.id);
    expect(active?.members).toHaveLength(1);
    expect(active?.members[0]?.role).toBe('owner');
  });

  it('setActive switches between two workspaces', async () => {
    const api = await signedInCaller('owner@example.com');
    const first = await api.workspace.create({ name: 'A', slug: 'a-ws' });
    const second = await api.workspace.create({ name: 'B', slug: 'b-ws' });

    await api.workspace.setActive({ workspaceId: first.id });
    const activeFirst = await api.workspace.active();
    expect(activeFirst?.id).toBe(first.id);

    await api.workspace.setActive({ workspaceId: second.id });
    const activeSecond = await api.workspace.active();
    expect(activeSecond?.id).toBe(second.id);
  });

  it('slug is parsed at the boundary (uppercase rejected before the vendor)', async () => {
    const api = await signedInCaller('owner@example.com');
    await expect(api.workspace.create({ name: 'X', slug: 'Not-Lower' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('duplicate slug maps to CONFLICT with a friendly message', async () => {
    const api = await signedInCaller('owner@example.com');
    await api.workspace.create({ name: 'One', slug: 'same' });
    await expect(api.workspace.create({ name: 'Two', slug: 'same' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('a non-member cannot set a foreign workspace active', async () => {
    const owner = await signedInCaller('owner@example.com');
    const ws = await owner.workspace.create({ name: 'Private', slug: 'private-ws' });

    const stranger = await signedInCaller('stranger@example.com');
    await expect(stranger.workspace.setActive({ workspaceId: ws.id })).rejects.toBeTruthy();
    const strangerActive = await stranger.workspace.active();
    expect(strangerActive?.id).not.toBe(ws.id);
  });
});
