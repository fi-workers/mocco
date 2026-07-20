import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { CommitConfigService } from '@backend/domain/integration/CommitConfigService';
import { CommitSyncService } from '@backend/domain/integration/CommitSyncService';
import { ConnectionService } from '@backend/domain/integration/ConnectionService';
import { ProviderConnectionRevokedError } from '@backend/domain/integration/github/errors';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { ConnectStateRepo } from '@backend/domain/integration/repos/connect-state.repo';
import { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { WebhookDeliveryRepo } from '@backend/domain/integration/repos/webhook-delivery.repo';
import { MoccoConfigParser } from '@backend/domain/pipeline/MoccoConfigParser';
import { decodeYaml } from '@backend/domain/pipeline/yaml/decode';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { appRouter } from '@backend/transport/trpc/root';

import type { CommitSource, InstallationVerifier, RepoLister, SourceCommit } from '@backend/domain/integration/ports';
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

/** A provider whose installation access token has been revoked GitHub-side
 * (app uninstalled/suspended) — `listRepos` mints a token first and fails with
 * `ProviderConnectionRevokedError`, exactly like the real adapter. */
function fakeRevokedProvider(): RepoLister & InstallationVerifier {
  return {
    listRepos: async () => {
      throw new ProviderConnectionRevokedError(401);
    },
    verifyOwnership: async () => ({ ownerVerified: true, accountLogin: 'me', githubUserId: '1' }),
    installUrl: state => `https://example.test/install?state=${state}`,
  };
}

/** Plain object implementing the CommitSource port — records how many times the
 * backfill path reached out to the provider, without any real network call. */
function fakeCommitSource(): CommitSource & { calls: number } {
  const source = {
    calls: 0,
    listCommits: async (): Promise<SourceCommit[]> => {
      source.calls += 1;
      return [];
    },
    getConfigAtCommit: async () => null,
  };
  return source;
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
  let commitSync: CommitSyncService;
  let commitSource: CommitSource & { calls: number };

  beforeEach(async () => {
    t = await createTestDb();
    const provider = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
    const connections = new ProviderConnectionRepo(t.db);
    const repos = new RepoRepo(t.db);
    const connectStates = new ConnectStateRepo(t.db);
    connection = new ConnectionService({ connections, repos, connectStates, provider: fakeProvider() });
    commitSource = fakeCommitSource();
    commitSync = new CommitSyncService({
      commits: new CommitRepo(t.db),
      deliveries: new WebhookDeliveryRepo(t.db),
      connections,
      repos,
      connectStates,
      source: commitSource,
      configs: new CommitConfigService({
        configs: new CommitConfigRepo(t.db),
        commits: new CommitRepo(t.db),
        source: commitSource,
        parser: new MoccoConfigParser(decodeYaml),
      }),
    });
  });
  afterEach(async () => {
    await t.close();
  });

  // `hasConnection` gates both `connection` and `commitSync` together — in
  // production they are built side by side in `instance.ts` from the same
  // "is the GitHub App configured" check, so a caller never observes one
  // present without the other.
  const signedInCaller = async (email: string, hasConnection = true) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    return appRouter.createCaller({
      auth,
      workspace,
      connection: hasConnection ? connection : undefined,
      commitSync: hasConnection ? commitSync : undefined,
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

  it('a revoked GitHub installation surfaces availableRepos as FORBIDDEN, not INTERNAL_SERVER_ERROR', async () => {
    const revokedConnection = new ConnectionService({
      connections: new ProviderConnectionRepo(t.db),
      repos: new RepoRepo(t.db),
      connectStates: new ConnectStateRepo(t.db),
      provider: fakeRevokedProvider(),
    });
    const headers = await signUpViaHttp(auth, 'revoked@example.com');
    const session = await auth.getSession(headers);
    const api = appRouter.createCaller({
      auth,
      workspace,
      connection: revokedConnection,
      commitSync,
      session,
      headers,
    });
    const { workspace: ws } = await api.workspace.create({ name: 'W' });
    const conn = await revokedConnection.createConnection(ws.id, { externalAccountId: '900', accountLogin: 'acme' });

    await expect(api.integration.availableRepos({ workspaceId: ws.id, connectionId: conn.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
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

  describe('backfill on watch', () => {
    it('setting a non-null watched branch fires a best-effort backfill through commitSync', async () => {
      const api = await signedInCaller('backfill@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const conn = await connection.createConnection(ws.id, { externalAccountId: '900', accountLogin: 'acme' });
      const { repo } = await api.integration.addRepo({
        workspaceId: ws.id,
        connectionId: conn.id,
        externalRepoId: '111',
        watchedBranch: null,
      });

      await api.integration.setWatchedBranch({ workspaceId: ws.id, repoId: repo.id, watchedBranch: 'main' });

      // The backfill runs fire-and-forget (waitUntil) — poll rather than await
      // the mutation's own promise, which resolves before the backfill lands.
      await vi.waitFor(() => {
        expect(commitSource.calls).toBe(1);
      });
    });

    it('clearing the watched branch (null) does not trigger a backfill', async () => {
      const api = await signedInCaller('no-backfill@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const conn = await connection.createConnection(ws.id, { externalAccountId: '900', accountLogin: 'acme' });
      const { repo } = await api.integration.addRepo({
        workspaceId: ws.id,
        connectionId: conn.id,
        externalRepoId: '111',
        watchedBranch: 'main',
      });

      await api.integration.setWatchedBranch({ workspaceId: ws.id, repoId: repo.id, watchedBranch: null });

      // The null branch short-circuits in backfillRepo before waitUntil, so there
      // is no fire-and-forget race to wait out — the assertion is immediate.
      expect(commitSource.calls).toBe(0);
    });
  });

  describe('commits (candidate queue)', () => {
    it('returns newest-first, paginating via nextCursor', async () => {
      const api = await signedInCaller('commits@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const conn = await connection.createConnection(ws.id, { externalAccountId: '900', accountLogin: 'acme' });
      const { repo } = await api.integration.addRepo({
        workspaceId: ws.id,
        connectionId: conn.id,
        externalRepoId: '111',
        watchedBranch: 'main',
      });

      const commitRepo = new CommitRepo(t.db);
      await commitRepo.upsertMany(
        Array.from({ length: 3 }, (_unused, i) => ({
          repoId: repo.id,
          sha: `sha-${i}`,
          branch: 'main',
          message: `commit ${i}`,
          authorName: 'Author',
          authorEmail: 'author@example.com',
          committedAt: new Date(2026, 0, i + 1),
        })),
      );

      const page = await api.integration.commits({ workspaceId: ws.id, repoId: repo.id, cursor: null, limit: 2 });
      expect(page.commits).toHaveLength(2);
      expect(page.commits[0]?.sha).toBe('sha-2'); // newest (last inserted) first
      expect(page.commits[1]?.sha).toBe('sha-1');
      expect(typeof page.commits[0]?.seq).toBe('string'); // bigint serialized as string on the wire
      expect(page.nextCursor).not.toBeNull();

      const nextPage = await api.integration.commits({
        workspaceId: ws.id,
        repoId: repo.id,
        cursor: page.nextCursor,
        limit: 2,
      });
      expect(nextPage.commits).toHaveLength(1);
      expect(nextPage.commits[0]?.sha).toBe('sha-0');
      expect(nextPage.nextCursor).toBeNull();
    });

    it('a non-member cannot read another workspace commits', async () => {
      const owner = await signedInCaller('owner-commits@example.com');
      const { workspace: wsA } = await owner.workspace.create({ name: 'A' });
      const conn = await connection.createConnection(wsA.id, { externalAccountId: '900', accountLogin: 'acme' });
      const { repo } = await owner.integration.addRepo({
        workspaceId: wsA.id,
        connectionId: conn.id,
        externalRepoId: '111',
        watchedBranch: null,
      });

      const stranger = await signedInCaller('stranger-commits@example.com');
      await expect(
        stranger.integration.commits({ workspaceId: wsA.id, repoId: repo.id, cursor: null, limit: 20 }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a non-numeric cursor is rejected as BAD_REQUEST, not a 500', async () => {
      const api = await signedInCaller('commits-bad-cursor@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const conn = await connection.createConnection(ws.id, { externalAccountId: '900', accountLogin: 'acme' });
      const { repo } = await api.integration.addRepo({
        workspaceId: ws.id,
        connectionId: conn.id,
        externalRepoId: '111',
        watchedBranch: 'main',
      });

      // Regression: `cursor: 'abc'` used to pass the (bare-string) input schema
      // and then blow up as `BigInt('abc')` inside CommitSyncService.listCommits,
      // which tRPC surfaced as a masked INTERNAL_SERVER_ERROR. The schema now
      // constrains cursor to digit-strings, so this is caught at the boundary.
      await expect(
        api.integration.commits({ workspaceId: ws.id, repoId: repo.id, cursor: 'abc', limit: 20 }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });
});
