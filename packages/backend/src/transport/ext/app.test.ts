import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { ConnectionService } from '@backend/domain/integration/ConnectionService';
import { ConnectStateRepo } from '@backend/domain/integration/repos/connect-state.repo';
import { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createExtApp } from '@backend/transport/ext/app';

import type { GitHubProvider } from '@backend/domain/integration/github/provider';
import type { AvailableRepoDto } from '@mocco/common/integration';

const REPO_A: AvailableRepoDto = { externalRepoId: '111', owner: 'fi-workers', name: 'api', defaultBranch: 'main' };

function fakeProvider(isOwner = true): GitHubProvider {
  return {
    listRepos: async () => [REPO_A],
    verifyOwnership: async () => ({ ownerVerified: isOwner, accountLogin: 'acme', githubUserId: '77' }),
    installUrl: state => `https://example.test/install?state=${state}`,
    listCommits: async () => [],
  };
}

const signUp = async (auth: AuthService, email: string) => {
  const response = await auth.handler(
    new Request('https://local.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'fixture-password-1', name: 'fixture-user' }),
    }),
  );
  return new Headers({ cookie: response.headers.get('set-cookie') ?? '' });
};

async function get(app: ReturnType<typeof createExtApp>, query: string, headers = new Headers()) {
  return await app.request(`/api/ext/github/setup?${query}`, { headers });
}

describe('ext GitHub setup callback (pglite)', () => {
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

  /** Sign up, make a workspace, start an install, and return the pieces the callback needs. */
  async function primeInstall(email: string, connection: ConnectionService) {
    const headers = await signUp(auth, email);
    const session = await auth.getSession(headers);
    const { id: workspaceId } = await workspace.create(headers, { name: 'W' });
    const { installUrl } = await connection.startInstall(session?.user.id ?? '', workspaceId);
    const state = new URL(installUrl).searchParams.get('state') ?? '';
    return { headers, workspaceId, state };
  }

  it('redirects to sign-in when unauthenticated', async () => {
    const app = createExtApp({
      auth,
      connection: new ConnectionService({
        connections: new ProviderConnectionRepo(t.db),
        repos: new RepoRepo(t.db),
        connectStates: new ConnectStateRepo(t.db),
        provider: fakeProvider(),
      }),
      provider: fakeProvider(),
    });
    const res = await get(app, 'installation_id=555&code=abc&state=x');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/sign-in');
  });

  it('persists the connection and redirects to the workspace on a verified install', async () => {
    const connection = new ConnectionService({
      connections: new ProviderConnectionRepo(t.db),
      repos: new RepoRepo(t.db),
      connectStates: new ConnectStateRepo(t.db),
      provider: fakeProvider(),
    });
    const app = createExtApp({ auth, connection, provider: fakeProvider() });
    const { headers, workspaceId, state } = await primeInstall('ok@example.com', connection);

    const res = await get(app, `installation_id=555&code=abc&state=${state}&setup_action=install`, headers);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/workspaces/${workspaceId}`);
    expect(await connection.listConnections(workspaceId)).toHaveLength(1);
  });

  it('does not connect when ownership is not verified', async () => {
    const connection = new ConnectionService({
      connections: new ProviderConnectionRepo(t.db),
      repos: new RepoRepo(t.db),
      connectStates: new ConnectStateRepo(t.db),
      provider: fakeProvider(),
    });
    const app = createExtApp({ auth, connection, provider: fakeProvider(false) });
    const { headers, workspaceId, state } = await primeInstall('noown@example.com', connection);

    const res = await get(app, `installation_id=555&code=abc&state=${state}`, headers);
    expect(res.headers.get('location')).toBe('/workspaces?connect_error=1');
    expect(await connection.listConnections(workspaceId)).toHaveLength(0);
  });

  it('rejects a reused/invalid state', async () => {
    const connection = new ConnectionService({
      connections: new ProviderConnectionRepo(t.db),
      repos: new RepoRepo(t.db),
      connectStates: new ConnectStateRepo(t.db),
      provider: fakeProvider(),
    });
    const app = createExtApp({ auth, connection, provider: fakeProvider() });
    const { headers, state } = await primeInstall('reuse@example.com', connection);

    await get(app, `installation_id=555&code=abc&state=${state}`, headers); // consumes it
    const res = await get(app, `installation_id=555&code=abc&state=${state}`, headers); // reuse
    expect(res.headers.get('location')).toBe('/workspaces?connect_error=1');
  });

  it('shows a pending state when setup_action=request (no installation_id)', async () => {
    const connection = new ConnectionService({
      connections: new ProviderConnectionRepo(t.db),
      repos: new RepoRepo(t.db),
      connectStates: new ConnectStateRepo(t.db),
      provider: fakeProvider(),
    });
    const app = createExtApp({ auth, connection, provider: fakeProvider() });
    const { headers } = await primeInstall('pending@example.com', connection);

    const res = await get(app, 'setup_action=request&state=x', headers);
    expect(res.headers.get('location')).toBe('/workspaces?pending=1');
  });
});
