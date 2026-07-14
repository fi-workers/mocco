import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '#backend/domain/auth/AuthService';
import { createProvider } from '#backend/domain/auth/provider';
import { WorkspaceService } from '#backend/domain/auth/WorkspaceService';
import { createTestDb, type TestDb } from '#backend/infra/db/testing/pglite';

import { createTrpcHandler } from './handler';
import { appRouter } from './root';

import type { Context } from './trpc';

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
    appRouter.createCaller({ auth, workspace, session, headers });

  const signedInCaller = async (email: string) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    return caller(headers, session);
  };

  beforeEach(async () => {
    t = await createTestDb();
    const provider = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
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
    await expect(api.workspace.list()).resolves.toEqual({ workspaces: [] });
    await expect(api.workspace.active()).resolves.toEqual({ workspace: null });
  });

  it('a domain NotFoundError maps to NOT_FOUND at the transport (mapDomainErrors)', async () => {
    const owner = await signedInCaller('owner@example.com');
    const { workspace: ws } = await owner.workspace.create({ name: 'Private' });

    // A non-member update makes the service throw WorkspaceNotFoundError; the
    // central middleware turns it into NOT_FOUND (not a masked 500).
    const stranger = await signedInCaller('stranger@example.com');
    await expect(stranger.workspace.update({ workspaceId: ws.id, name: 'Renamed' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('create → list → active round-trip', async () => {
    const api = await signedInCaller('owner@example.com');

    const { workspace: ws } = await api.workspace.create({ name: 'Acme Lab' });
    expect(ws.name).toBe('Acme Lab');
    // Egress contract: raw vendor rows carry `metadata` and the system slug
    // (probe-verified); the .output() schema strips both and normalizes logo
    // to `string | null`. The slug is a vendor-internal token, never on the wire.
    expect(ws).not.toHaveProperty('metadata');
    expect(ws).not.toHaveProperty('slug');
    expect(ws.logo).toBeNull();

    const { workspaces } = await api.workspace.list();
    expect(workspaces).toHaveLength(1);

    const { workspace: active } = await api.workspace.active();
    expect(active?.id).toBe(ws.id);
    expect(active?.members).toHaveLength(1);
    expect(active?.members[0]?.role).toBe('owner');
  });

  it('setActive switches between two workspaces', async () => {
    const api = await signedInCaller('owner@example.com');
    const { workspace: first } = await api.workspace.create({ name: 'A' });
    const { workspace: second } = await api.workspace.create({ name: 'B' });

    const switched = await api.workspace.setActive({ workspaceId: first.id });
    expect(switched).toEqual({ ok: true });
    const activeFirst = await api.workspace.active();
    expect(activeFirst.workspace?.id).toBe(first.id);

    await api.workspace.setActive({ workspaceId: second.id });
    const activeSecond = await api.workspace.active();
    expect(activeSecond.workspace?.id).toBe(second.id);
  });

  it('two workspaces can share a name — the slug is a system-generated uuid, so there is no collision', async () => {
    const api = await signedInCaller('owner@example.com');
    const { workspace: first } = await api.workspace.create({ name: 'Same Name' });
    const { workspace: second } = await api.workspace.create({ name: 'Same Name' });
    expect(second.id).not.toBe(first.id);
    const { workspaces } = await api.workspace.list();
    expect(workspaces).toHaveLength(2);
  });

  it('a non-member cannot set a foreign workspace active', async () => {
    const owner = await signedInCaller('owner@example.com');
    const { workspace: ws } = await owner.workspace.create({ name: 'Private' });

    const stranger = await signedInCaller('stranger@example.com');
    await expect(stranger.workspace.setActive({ workspaceId: ws.id })).rejects.toMatchObject({
      message: expect.stringMatching(/not a member/i) as string, // vendor FORBIDDEN
    });
    await expect(stranger.workspace.active()).resolves.toEqual({ workspace: null });

    // owner unaffected — still the only session pointing at the workspace
    const ownerActive = await owner.workspace.active();
    expect(ownerActive.workspace?.id).toBe(ws.id);
  });

  it('setActive with a valid-but-nonexistent uuid is rejected', async () => {
    const api = await signedInCaller('owner@example.com');
    await api.workspace.create({ name: 'Mine' });
    await expect(
      api.workspace.setActive({ workspaceId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/not a member/i) as string });
  });

  it('pipeline.preview parses a valid .mocco.yml (no persistence)', async () => {
    const api = await signedInCaller('preview@example.com');
    const result = await api.pipeline.preview({
      source: 'version: 1\npipeline: deploy\nsteps:\n  - run: build\n    executor: generic',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.pipeline).toBe('deploy');
      expect(result.config.steps).toHaveLength(1);
    }
  });

  it('pipeline.preview reports issues for an invalid config', async () => {
    const api = await signedInCaller('preview@example.com');
    const result = await api.pipeline.preview({ source: 'version: 1\npipeline: p\nsteps: []' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some(issue => issue.path.startsWith('steps'))).toBe(true);
    }
  });

  it('pipeline.preview requires a session', async () => {
    const anonymous = caller(new Headers(), null);
    await expect(anonymous.pipeline.preview({ source: 'version: 1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
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
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
  });
  afterEach(async () => {
    await t.close();
  });

  it('health responds; authed workspace.list round-trips a Date through superjson', async () => {
    const trpcHandler = createTrpcHandler({ auth, workspace });

    const health = await trpcHandler(new Request('https://local.test/api/trpc/health'));
    expect(health.status).toBe(200);

    const sessionHeaders = await signUpViaHttp(auth, 'wire@example.com');
    const cookie = sessionHeaders.get('cookie') ?? '';
    await workspace.create(sessionHeaders, { name: 'Wire' });

    const res = await trpcHandler(new Request('https://local.test/api/trpc/workspace.list', { headers: { cookie } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { data: { json: { workspaces: { name: string; createdAt: unknown }[] }; meta?: unknown } };
    };
    expect(body.result.data.json.workspaces[0]?.name).toBe('Wire');
    expect(body.result.data.meta).toBeDefined(); // superjson envelope carrying the Date
  });
});
