import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConnectionService } from '@backend/domain/integration/ConnectionService';
import { ProviderConnectionNotFoundError, RepoNotFoundError } from '@backend/domain/integration/errors';
import { ConnectStateRepo } from '@backend/domain/integration/repos/connect-state.repo';
import { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { InstallationVerifier, RepoLister } from '@backend/domain/integration/ports';
import type { AvailableRepoDto } from '@mocco/common/integration';

function fakeProvider(repos: AvailableRepoDto[]): RepoLister & InstallationVerifier {
  return {
    listRepos: async () => repos,
    verifyOwnership: async () => ({ ownerVerified: true, accountLogin: 'me', githubUserId: '1' }),
    installUrl: state => `https://example.test/install?state=${state}`,
  };
}

const REPO_A: AvailableRepoDto = { externalRepoId: '111', owner: 'fi-workers', name: 'api', defaultBranch: 'main' };
const REPO_B: AvailableRepoDto = { externalRepoId: '222', owner: 'fi-workers', name: 'web', defaultBranch: 'trunk' };

describe('ConnectionService (pglite)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  async function seedWorkspace(name = 'W'): Promise<string> {
    const [row] = await t.db.insert(workspaces).values({ name, slug: randomUUID() }).returning();
    if (row === undefined) {
      throw new Error('no workspace');
    }
    return row.id;
  }

  function service(repos: AvailableRepoDto[] = [REPO_A, REPO_B]): ConnectionService {
    return new ConnectionService({
      connections: new ProviderConnectionRepo(t.db),
      repos: new RepoRepo(t.db),
      connectStates: new ConnectStateRepo(t.db),
      provider: fakeProvider(repos),
    });
  }

  it('startInstall persists a state row and returns the install URL', async () => {
    const workspaceId = await seedWorkspace();
    const svc = service();
    const { installUrl } = await svc.startInstall(randomUUID(), workspaceId);
    expect(installUrl).toContain('https://example.test/install?state=');
    const connections = await svc.listConnections(workspaceId);
    expect(connections).toHaveLength(0); // no connection yet — only a pending state
  });

  it('consumeConnectState returns the workspace once, then rejects reuse', async () => {
    const workspaceId = await seedWorkspace();
    const userId = randomUUID();
    const svc = service();
    const { installUrl } = await svc.startInstall(userId, workspaceId);
    const state = new URL(installUrl).searchParams.get('state') ?? '';
    expect(await svc.consumeConnectState(state, userId)).toEqual({ workspaceId });
    await expect(svc.consumeConnectState(state, userId)).rejects.toThrow(); // single-use
  });

  it('consumeConnectState rejects a state owned by another user', async () => {
    const workspaceId = await seedWorkspace();
    const svc = service();
    const { installUrl } = await svc.startInstall(randomUUID(), workspaceId);
    const state = new URL(installUrl).searchParams.get('state') ?? '';
    await expect(svc.consumeConnectState(state, randomUUID())).rejects.toThrow();
  });

  it('createConnection upserts on (provider, external_account_id)', async () => {
    const workspaceId = await seedWorkspace();
    const svc = service();
    const first = await svc.createConnection(workspaceId, { externalAccountId: '900', accountLogin: 'acme' });
    const second = await svc.createConnection(workspaceId, { externalAccountId: '900', accountLogin: 'acme-renamed' });
    expect(second.id).toBe(first.id);
    expect(second.accountLogin).toBe('acme-renamed');
    expect(await svc.listConnections(workspaceId)).toHaveLength(1);
  });

  it('availableRepos returns the provider repos; a foreign connection is NotFound', async () => {
    const workspaceId = await seedWorkspace();
    const svc = service();
    const conn = await svc.createConnection(workspaceId, { externalAccountId: '900', accountLogin: 'acme' });
    expect(await svc.availableRepos(workspaceId, conn.id)).toHaveLength(2);
    await expect(svc.availableRepos(randomUUID(), conn.id)).rejects.toBeInstanceOf(ProviderConnectionNotFoundError);
  });

  it('addRepo takes owner/name/defaultBranch authoritatively from the provider', async () => {
    const workspaceId = await seedWorkspace();
    const svc = service();
    const conn = await svc.createConnection(workspaceId, { externalAccountId: '900', accountLogin: 'acme' });
    const repo = await svc.addRepo(workspaceId, { connectionId: conn.id, externalRepoId: '111', watchedBranch: null });
    expect(repo.owner).toBe('fi-workers');
    expect(repo.name).toBe('api');
    expect(repo.defaultBranch).toBe('main');
    expect(repo.watchedBranch).toBeNull();
  });

  it('addRepo rejects a repo the installation cannot access', async () => {
    const workspaceId = await seedWorkspace();
    const svc = service();
    const conn = await svc.createConnection(workspaceId, { externalAccountId: '900', accountLogin: 'acme' });
    await expect(
      svc.addRepo(workspaceId, { connectionId: conn.id, externalRepoId: '999', watchedBranch: null }),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('setWatchedBranch updates within the workspace and rejects a foreign repo', async () => {
    const workspaceId = await seedWorkspace();
    const svc = service();
    const conn = await svc.createConnection(workspaceId, { externalAccountId: '900', accountLogin: 'acme' });
    const repo = await svc.addRepo(workspaceId, { connectionId: conn.id, externalRepoId: '111', watchedBranch: null });
    const updated = await svc.setWatchedBranch(workspaceId, repo.id, 'release');
    expect(updated.watchedBranch).toBe('release');
    await expect(svc.setWatchedBranch(randomUUID(), repo.id, 'main')).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('listRepos is scoped to the workspace', async () => {
    const workspaceA = await seedWorkspace('A');
    const workspaceB = await seedWorkspace('B');
    const svc = service();
    const connA = await svc.createConnection(workspaceA, { externalAccountId: '900', accountLogin: 'a' });
    await svc.addRepo(workspaceA, { connectionId: connA.id, externalRepoId: '111', watchedBranch: null });
    expect(await svc.listRepos(workspaceA)).toHaveLength(1);
    expect(await svc.listRepos(workspaceB)).toHaveLength(0);
  });
});
