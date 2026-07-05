import { createAuthService, type AuthService } from '../auth/AuthService';
import { createProvider } from '../auth/provider';
import { createWorkspaceService, type WorkspaceService } from '../auth/WorkspaceService';
import { createTestDb, type TestDb } from '../db/testing/pglite';

import { createTrpcHandler } from './handler';
import { appRouter } from './router';

import type { Context } from './trpc';
import type { Db } from '../db/client';

/** Sign up through the production auth handler (HTTP) and keep the session cookie. */
const signUpViaHttp = async (auth: AuthService, email: string) => {
  const response = await auth.handler(
    new Request('https://local.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'fixture-password-1', name: 'fixture-user' }),
    }),
  );
  return new Headers({ cookie: response.headers.get('set-cookie') ?? '' });
};

// Full-stack tRPC tests on pglite: real migrations + real auth service + real
// router. No test seams — tests compose the same factories production uses.
describe('tRPC workspace router on pglite', () => {
  let t: TestDb;
  let auth: AuthService;
  let workspace: WorkspaceService;

  const caller = (headers: Headers, session: Context['session']) =>
    appRouter.createCaller({ db: t.db as unknown as Db, auth, workspace, session, headers });

  const signedInCaller = async (email: string) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    return caller(headers, session);
  };

  beforeEach(async () => {
    t = await createTestDb();
    const provider = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    auth = createAuthService(provider);
    workspace = createWorkspaceService(provider);
  });
  afterEach(async () => {
    await t.close();
  });

  it('unauthenticated calls are UNAUTHORIZED', async () => {
    const anonymous = caller(new Headers(), null);
    await expect(anonymous.workspace.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('a fresh user has no workspaces and no active workspace (null contract)', async () => {
    const api = await signedInCaller('fresh@example.com');
    await expect(api.workspace.list()).resolves.toHaveLength(0);
    await expect(api.workspace.active()).resolves.toBeNull();
  });

  it('create → list → active round-trip', async () => {
    const api = await signedInCaller('owner@example.com');

    const ws = await api.workspace.create({ name: 'Acme Lab', slug: 'acme-lab' });
    expect(ws.slug).toBe('acme-lab');
    // Egress contract: raw vendor rows carry `metadata` (probe-verified); the
    // .output() schema strips it and normalizes logo to `string | null`.
    expect(ws).not.toHaveProperty('metadata');
    expect(ws.logo).toBeNull();

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

    const switched = await api.workspace.setActive({ workspaceId: first.id });
    expect(switched).toEqual({ ok: true });
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
    await expect(api.workspace.create({ name: 'X', slug: 'a' })).rejects.toMatchObject({
      code: 'BAD_REQUEST', // below min length 2
    });
    await expect(api.workspace.list()).resolves.toHaveLength(0); // vendor never reached, no rows
  });

  it('duplicate slug maps to CONFLICT with a friendly message', async () => {
    const api = await signedInCaller('owner@example.com');
    await api.workspace.create({ name: 'One', slug: 'same' });
    await expect(api.workspace.create({ name: 'Two', slug: 'same' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'That slug is already taken.',
    });
  });

  it('a non-member cannot set a foreign workspace active', async () => {
    const owner = await signedInCaller('owner@example.com');
    const ws = await owner.workspace.create({ name: 'Private', slug: 'private-ws' });

    const stranger = await signedInCaller('stranger@example.com');
    await expect(stranger.workspace.setActive({ workspaceId: ws.id })).rejects.toMatchObject({
      message: expect.stringMatching(/not a member/i) as string, // vendor FORBIDDEN
    });
    await expect(stranger.workspace.active()).resolves.toBeNull();

    // owner unaffected — still the only session pointing at the workspace
    const ownerActive = await owner.workspace.active();
    expect(ownerActive?.id).toBe(ws.id);
  });

  it('a case-variant race hitting the DB index still maps to CONFLICT', async () => {
    const api = await signedInCaller('owner@example.com');
    // Bypass zod+vendor pre-check by inserting an uppercase slug directly; the
    // router's lowercase create then collides on lower(slug) → pg 23505 → CONFLICT.
    await t.db.insert(t.schema.workspaces).values({ name: 'Taken', slug: 'TAKEN' });
    await expect(api.workspace.create({ name: 'Mine', slug: 'taken' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('setActive with a valid-but-nonexistent uuid is rejected', async () => {
    const api = await signedInCaller('owner@example.com');
    await api.workspace.create({ name: 'Mine', slug: 'mine' });
    await expect(
      api.workspace.setActive({ workspaceId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/not a member/i) as string });
  });
});

// HTTP-level: the mounted handler with a real Request — exercises createContext,
// the neutral getSession, and the superjson wire format (Dates revive).
describe('trpcHandler over HTTP', () => {
  let t: TestDb;
  let auth: AuthService;
  let workspace: WorkspaceService;

  beforeEach(async () => {
    t = await createTestDb();
    const provider = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    auth = createAuthService(provider);
    workspace = createWorkspaceService(provider);
  });
  afterEach(async () => {
    await t.close();
  });

  it('health responds; authed workspace.list round-trips a Date through superjson', async () => {
    const trpcHandler = createTrpcHandler({ db: t.db as unknown as Db, auth, workspace });

    const health = await trpcHandler(new Request('https://local.test/api/trpc/health'));
    expect(health.status).toBe(200);

    const sessionHeaders = await signUpViaHttp(auth, 'wire@example.com');
    const cookie = sessionHeaders.get('cookie') ?? '';
    await workspace.create(sessionHeaders, { name: 'Wire', slug: 'wire-ws' });

    const res = await trpcHandler(new Request('https://local.test/api/trpc/workspace.list', { headers: { cookie } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { data: { json: { slug: string; createdAt: unknown }[]; meta?: unknown } };
    };
    expect(body.result.data.json[0]?.slug).toBe('wire-ws');
    expect(body.result.data.meta).toBeDefined(); // superjson envelope carrying the Date
  });
});
