import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { ConnectionService } from '@backend/domain/integration/ConnectionService';
import { ConnectStateRepo } from '@backend/domain/integration/repos/connect-state.repo';
import { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { appRouter } from '@backend/transport/trpc/root';

import type { InstallationVerifier, RepoLister } from '@backend/domain/integration/ports';
import type { AvailableRepoDto } from '@mocco/common/integration';

const REPO_A: AvailableRepoDto = { externalRepoId: '111', owner: 'fi-workers', name: 'api', defaultBranch: 'main' };
const REPO_B: AvailableRepoDto = { externalRepoId: '222', owner: 'fi-workers', name: 'web', defaultBranch: 'trunk' };

function fakeProvider(): RepoLister & InstallationVerifier {
  return {
    listRepos: async () => [REPO_A, REPO_B],
    verifyOwnership: async () => ({ ownerVerified: true, accountLogin: 'me', githubUserId: '1' }),
    installUrl: state => `https://example.test/install?state=${state}`,
  };
}

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

describe('integration router on pglite', () => {
  let t: TestDb;
  let auth: AuthService;
  let workspace: WorkspaceService;
  let connection: ConnectionService;

  beforeEach(async () => {
    t = await createTestDb();
    const provider = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
    connection = new ConnectionService({
      connections: new ProviderConnectionRepo(t.db),
      repos: new RepoRepo(t.db),
      connectStates: new ConnectStateRepo(t.db),
      provider: fakeProvider(),
    });
  });
  afterEach(async () => {
    await t.close();
  });

  const signedInCaller = async (email: string, hasConnection = true) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    return appRouter.createCaller({
      auth,
      workspace,
      connection: hasConnection ? connection : undefined,
      session,
      headers,
    });
  };

  it('is PRECONDITION_FAILED when the GitHub App is not configured', async () => {
    const api = await signedInCaller('a@example.com', false);
    const { workspace: ws } = await api.workspace.create({ name: 'W' });
    await expect(api.integration.repos({ workspaceId: ws.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('startInstall returns an install URL', async () => {
    const api = await signedInCaller('b@example.com');
    const { workspace: ws } = await api.workspace.create({ name: 'W' });
    const { installUrl } = await api.integration.startInstall({ workspaceId: ws.id });
    expect(installUrl).toContain('https://example.test/install?state=');
  });

  it('availableRepos + addRepo + repos round-trip; externalAccountId is not leaked', async () => {
    const api = await signedInCaller('c@example.com');
    const { workspace: ws } = await api.workspace.create({ name: 'W' });
    const conn = await connection.createConnection(ws.id, { externalAccountId: '900', accountLogin: 'acme' });

    const listed = await api.integration.connections({ workspaceId: ws.id });
    expect(listed.connections).toEqual([{ id: conn.id, provider: 'github', accountLogin: 'acme' }]); // no externalAccountId

    const available = await api.integration.availableRepos({ workspaceId: ws.id, connectionId: conn.id });
    expect(available.repos).toHaveLength(2);
    await api.integration.addRepo({
      workspaceId: ws.id,
      connectionId: conn.id,
      externalRepoId: '111',
      watchedBranch: null,
    });
    const { repos } = await api.integration.repos({ workspaceId: ws.id });
    expect(repos).toHaveLength(1);
    expect(repos[0]?.name).toBe('api');
  });

  it("addRepo against another workspace's connection maps to NOT_FOUND", async () => {
    const owner = await signedInCaller('owner@example.com');
    const { workspace: wsA } = await owner.workspace.create({ name: 'A' });
    const conn = await connection.createConnection(wsA.id, { externalAccountId: '900', accountLogin: 'acme' });

    const stranger = await signedInCaller('stranger@example.com');
    const { workspace: wsB } = await stranger.workspace.create({ name: 'B' });
    await expect(
      stranger.integration.addRepo({
        workspaceId: wsB.id,
        connectionId: conn.id,
        externalRepoId: '111',
        watchedBranch: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // Tenant isolation is a correctness property (spec INVARIANT a): scoping queries
  // by a *caller-supplied* workspaceId is meaningless unless that workspaceId is
  // itself authorized against the session. These exercise the real attack — a
  // non-member passing the VICTIM's workspaceId — which every procedure must reject.
  describe('cross-tenant: the caller must be a member of the passed workspaceId', () => {
    it('a non-member cannot read another workspace (repos / connections)', async () => {
      const owner = await signedInCaller('owner-r@example.com');
      const { workspace: wsA } = await owner.workspace.create({ name: 'A' });
      await connection.createConnection(wsA.id, { externalAccountId: '900', accountLogin: 'acme' });

      const stranger = await signedInCaller('stranger-r@example.com');
      await expect(stranger.integration.repos({ workspaceId: wsA.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(stranger.integration.connections({ workspaceId: wsA.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('a non-member cannot list another workspace connection live repos', async () => {
      const owner = await signedInCaller('owner-a@example.com');
      const { workspace: wsA } = await owner.workspace.create({ name: 'A' });
      const conn = await connection.createConnection(wsA.id, { externalAccountId: '900', accountLogin: 'acme' });

      const stranger = await signedInCaller('stranger-a@example.com');
      await expect(
        stranger.integration.availableRepos({ workspaceId: wsA.id, connectionId: conn.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a non-member cannot write into another workspace (addRepo with the victim workspaceId)', async () => {
      const owner = await signedInCaller('owner-w@example.com');
      const { workspace: wsA } = await owner.workspace.create({ name: 'A' });
      const conn = await connection.createConnection(wsA.id, { externalAccountId: '900', accountLogin: 'acme' });

      const stranger = await signedInCaller('stranger-w@example.com');
      await expect(
        stranger.integration.addRepo({
          workspaceId: wsA.id,
          connectionId: conn.id,
          externalRepoId: '111',
          watchedBranch: null,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a non-member cannot setWatchedBranch on another workspace repo', async () => {
      const owner = await signedInCaller('owner-s@example.com');
      const { workspace: wsA } = await owner.workspace.create({ name: 'A' });
      const conn = await connection.createConnection(wsA.id, { externalAccountId: '900', accountLogin: 'acme' });
      const { repo } = await owner.integration.addRepo({
        workspaceId: wsA.id,
        connectionId: conn.id,
        externalRepoId: '111',
        watchedBranch: null,
      });

      const stranger = await signedInCaller('stranger-s@example.com');
      await expect(
        stranger.integration.setWatchedBranch({ workspaceId: wsA.id, repoId: repo.id, watchedBranch: 'main' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a non-member cannot startInstall for another workspace', async () => {
      const owner = await signedInCaller('owner-i@example.com');
      const { workspace: wsA } = await owner.workspace.create({ name: 'A' });

      const stranger = await signedInCaller('stranger-i@example.com');
      await expect(stranger.integration.startInstall({ workspaceId: wsA.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
