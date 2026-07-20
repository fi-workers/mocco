import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommitSyncService } from '@backend/domain/integration/CommitSyncService';
import { ConnectionStatuses, RepoStatuses } from '@backend/domain/integration/constants';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { ConnectStateRepo } from '@backend/domain/integration/repos/connect-state.repo';
import { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { WebhookDeliveryRepo } from '@backend/domain/integration/repos/webhook-delivery.repo';
import { githubConnectStates, providerConnections, repos, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { ParsedWebhook } from '@backend/domain/integration/github/webhook-events';
import type { CommitSource, SourceCommit } from '@backend/domain/integration/ports';
import type * as schema from '@backend/infra/db/schema';

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected one row');
  }
  return row;
}

/** Plain object implementing the CommitSource port — no vi.mock, no prod test-hooks. */
function fakeSource(commits: SourceCommit[]): CommitSource & { calls: number } {
  const source = {
    calls: 0,
    listCommits: async () => {
      source.calls += 1;
      return commits;
    },
    getConfigAtCommit: async () => null,
  };
  return source;
}

type PushData = Extract<ParsedWebhook, { kind: 'push' }>['data'];
type InstallationData = Extract<ParsedWebhook, { kind: 'installation' }>['data'];

function pushEvent(args: {
  installationId: number;
  repoExternalId: number;
  ref?: string;
  commits: SourceCommit[];
}): PushData {
  return {
    ref: args.ref ?? 'refs/heads/main',
    installation: { id: args.installationId },
    repository: { id: args.repoExternalId, name: 'n', owner: { login: 'o' } },
    commits: args.commits.map(c => ({
      id: c.sha,
      message: c.message,
      timestamp: c.committedAt.toISOString(),
      author: { name: c.authorName, email: c.authorEmail },
    })),
  };
}

function installationEvent(args: {
  action: InstallationData['action'];
  installationId: number;
  senderId: number;
  accountLogin?: string;
}): InstallationData {
  return {
    action: args.action,
    installation: { id: args.installationId, account: { login: args.accountLogin ?? 'acme', id: args.installationId } },
    sender: { login: 'someone', id: args.senderId },
  };
}

function srcCommit(sha: string, overrides: Partial<SourceCommit> = {}): SourceCommit {
  return {
    sha,
    message: `msg ${sha}`,
    authorName: 'Author',
    authorEmail: 'author@example.com',
    committedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('CommitSyncService (pglite)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  function service(source: CommitSource = fakeSource([])): CommitSyncService {
    return new CommitSyncService({
      commits: new CommitRepo(t.db),
      deliveries: new WebhookDeliveryRepo(t.db),
      connections: new ProviderConnectionRepo(t.db),
      repos: new RepoRepo(t.db),
      source,
      connectStates: new ConnectStateRepo(t.db),
    });
  }

  async function seedWorkspace(name = 'W'): Promise<string> {
    return one(await t.db.insert(workspaces).values({ name, slug: randomUUID() }).returning()).id;
  }

  async function seedConnection(workspaceId: string, externalAccountId: string) {
    return one(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId, accountLogin: 'acme' })
        .returning(),
    );
  }

  async function seedRepo(
    workspaceId: string,
    connectionId: string,
    overrides: Partial<typeof schema.repos.$inferInsert> = {},
  ) {
    return one(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId,
          externalRepoId: randomUUID(),
          owner: 'o',
          name: 'n',
          defaultBranch: 'main',
          watchedBranch: 'main',
          ...overrides,
        })
        .returning(),
    );
  }

  async function commitCount(repoId: string): Promise<number> {
    const rows = await new CommitRepo(t.db).listByRepo(repoId, null, 500);
    return rows.length;
  }

  async function commitShaSet(repoId: string): Promise<Set<string>> {
    const rows = await new CommitRepo(t.db).listByRepo(repoId, null, 500);
    return new Set(rows.map(r => r.sha));
  }

  it('push for a watched branch writes commit rows under the right repo; redelivery is idempotent', async () => {
    const workspaceId = await seedWorkspace();
    const conn = await seedConnection(workspaceId, '5000');
    const repo = await seedRepo(workspaceId, conn.id, { externalRepoId: '900', watchedBranch: 'main' });
    const svc = service();
    const event = pushEvent({ installationId: 5000, repoExternalId: 900, commits: [srcCommit('c1'), srcCommit('c2')] });

    await svc.handle({ kind: 'push', data: event });
    expect(await commitCount(repo.id)).toBe(2);

    // A second identical delivery must not create duplicate rows (upsert on repo_id, sha).
    await svc.handle({ kind: 'push', data: event });
    expect(await commitCount(repo.id)).toBe(2);

    const touched = one(await t.db.select().from(repos).where(eq(repos.id, repo.id)));
    expect(touched.lastSyncedAt).not.toBeNull();
  });

  it('push whose installation_id has no connection is parked (no write, no throw)', async () => {
    const workspaceId = await seedWorkspace();
    const conn = await seedConnection(workspaceId, '5000');
    const repo = await seedRepo(workspaceId, conn.id, { externalRepoId: '900' });
    const svc = service();

    await expect(
      svc.syncPush(pushEvent({ installationId: 999_999, repoExternalId: 900, commits: [srcCommit('c1')] })),
    ).resolves.toBeUndefined();
    expect(await commitCount(repo.id)).toBe(0);
  });

  it('TENANT ISOLATION: same external_repo_id in two workspaces — a push writes ONLY the resolved tenant', async () => {
    const wsA = await seedWorkspace('A');
    const wsB = await seedWorkspace('B');
    const connA = await seedConnection(wsA, '1111');
    const connB = await seedConnection(wsB, '2222');
    // Both tenants registered a repo carrying the SAME provider external_repo_id.
    const repoA = await seedRepo(wsA, connA.id, { externalRepoId: '555', watchedBranch: 'main' });
    const repoB = await seedRepo(wsB, connB.id, { externalRepoId: '555', watchedBranch: 'main' });
    const svc = service();

    // Independent pushes for each installation, carrying distinct commits.
    await svc.syncPush(
      pushEvent({ installationId: 1111, repoExternalId: 555, commits: [srcCommit('a1'), srcCommit('a2')] }),
    );
    await svc.syncPush(
      pushEvent({ installationId: 2222, repoExternalId: 555, commits: [srcCommit('b1'), srcCommit('b2')] }),
    );

    // Each repo holds ONLY its own tenant's commits. If resolution were by external_repo_id
    // alone (ignoring the connection), both pushes would collapse onto whichever repo the
    // ambiguous query returned first — one repo would hold all four shas, the other none.
    // This exact-set assertion fails under that bug regardless of row ordering.
    expect(await commitShaSet(repoA.id)).toEqual(new Set(['a1', 'a2']));
    expect(await commitShaSet(repoB.id)).toEqual(new Set(['b1', 'b2']));
  });

  it('push for a non-watched branch is skipped', async () => {
    const workspaceId = await seedWorkspace();
    const conn = await seedConnection(workspaceId, '5000');
    const repo = await seedRepo(workspaceId, conn.id, { externalRepoId: '900', watchedBranch: 'main' });
    const svc = service();

    await svc.syncPush(
      pushEvent({ installationId: 5000, repoExternalId: 900, ref: 'refs/heads/feature', commits: [srcCommit('c1')] }),
    );
    expect(await commitCount(repo.id)).toBe(0);
  });

  it('installation.deleted marks the connection deleted and its repos inactive, preserving commits', async () => {
    const workspaceId = await seedWorkspace();
    const conn = await seedConnection(workspaceId, '5000');
    const repo = await seedRepo(workspaceId, conn.id, { externalRepoId: '900', watchedBranch: 'main' });
    const svc = service();
    await svc.syncPush(pushEvent({ installationId: 5000, repoExternalId: 900, commits: [srcCommit('c1')] }));
    expect(await commitCount(repo.id)).toBe(1);

    await svc.handle({
      kind: 'installation',
      data: installationEvent({ action: 'deleted', installationId: 5000, senderId: 1 }),
    });

    const connAfter = one(await t.db.select().from(providerConnections).where(eq(providerConnections.id, conn.id)));
    const repoAfter = one(await t.db.select().from(repos).where(eq(repos.id, repo.id)));
    expect(connAfter.status).toBe(ConnectionStatuses.deleted);
    expect(repoAfter.status).toBe(RepoStatuses.inactive);
    // Commits are historical — never deleted with the installation.
    expect(await commitCount(repo.id)).toBe(1);
  });

  it('installation.created reconciles a pending connect-state into a connection; unmatched sender is parked', async () => {
    const workspaceId = await seedWorkspace();
    await t.db.insert(githubConnectStates).values({
      state: randomUUID(),
      userId: randomUUID(),
      workspaceId,
      githubUserId: '77',
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    const svc = service();

    // Unmatched sender → parked (no connection).
    await svc.handle({
      kind: 'installation',
      data: installationEvent({ action: 'created', installationId: 8000, senderId: 999 }),
    });
    expect(
      await t.db.select().from(providerConnections).where(eq(providerConnections.workspaceId, workspaceId)),
    ).toHaveLength(0);

    // Matching sender.id → connection created for the state's workspace.
    await svc.handle({
      kind: 'installation',
      data: installationEvent({ action: 'created', installationId: 8000, senderId: 77, accountLogin: 'acme' }),
    });
    const conns = await t.db.select().from(providerConnections).where(eq(providerConnections.workspaceId, workspaceId));
    expect(conns).toHaveLength(1);
    expect(one(conns).externalAccountId).toBe('8000');
  });

  it('backfillRepo lands FakeCommitSource commits and re-running is idempotent', async () => {
    const workspaceId = await seedWorkspace();
    const conn = await seedConnection(workspaceId, '5000');
    const repo = await seedRepo(workspaceId, conn.id, { externalRepoId: '900', watchedBranch: 'main' });
    const source = fakeSource([srcCommit('b1'), srcCommit('b2'), srcCommit('b3')]);
    const svc = service(source);

    await svc.backfillRepo(repo);
    expect(await commitCount(repo.id)).toBe(3);
    await svc.backfillRepo(repo);
    expect(await commitCount(repo.id)).toBe(3);
    expect(source.calls).toBe(2);
  });
});
