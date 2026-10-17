import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AuditActions } from '@mocco/common/audit';
import { FeedbackLinkKinds, FeedbackLinkStates } from '@mocco/common/feedback';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { LinkRefreshPolicy } from '@backend/domain/feedback/LinkService';
import { CommitConfigService } from '@backend/domain/integration/CommitConfigService';
import { CommitSyncService } from '@backend/domain/integration/CommitSyncService';
import { parseWebhook } from '@backend/domain/integration/github/provider';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { ConnectStateRepo } from '@backend/domain/integration/repos/connect-state.repo';
import { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { WebhookDeliveryRepo } from '@backend/domain/integration/repos/webhook-delivery.repo';
import { MoccoConfigParser } from '@backend/domain/pipeline/MoccoConfigParser';
import { decodeYaml } from '@backend/domain/pipeline/yaml/decode';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  feedbackLinkClosers,
  feedbackLinks,
  projectRepos,
  providerConnections,
  repos,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type {
  CommitSource,
  IssueTracker,
  TrackerItem,
  TrackerPullRequest,
  TrackerRepoRef,
} from '@backend/domain/integration/ports';
import type { FeedbackLinkKind } from '@mocco/common/feedback';

const NOW = new Date('2026-10-17T12:00:00Z');
// The fixtures' installation and repo (domain/integration/testdata).
const INSTALLATION_ID = '12345678';
const EXTERNAL_REPO_ID = '654321';

function readFixture(name: string): string {
  // eslint-disable-next-line n/no-sync -- tiny fixture, read once per test
  return readFileSync(fileURLToPath(new URL(`../integration/testdata/${name}`, import.meta.url)), 'utf8');
}

const item = (kind: FeedbackLinkKind, number: number, overrides: Partial<TrackerItem> = {}): TrackerItem => ({
  kind,
  number,
  nodeId: `${kind}_${String(number)}`,
  title: `${kind} ${String(number)}`,
  url: `https://github.com/fi-workers/example-repo/${kind === FeedbackLinkKinds.issue ? 'issues' : 'pull'}/${String(number)}`,
  state: FeedbackLinkStates.open,
  mergeCommitSha: null,
  mergedAt: null,
  ...overrides,
});

const pull = (number: number, overrides: Partial<TrackerPullRequest> = {}): TrackerPullRequest => {
  const { nodeId, title, url, state, mergeCommitSha, mergedAt } = item(
    FeedbackLinkKinds.pullRequest,
    number,
    overrides,
  );
  return { number, nodeId, title, url, state, mergeCommitSha, mergedAt };
};

/** The IssueTracker port over in-memory issues and pull requests, recording the repos it was asked about. */
class FakeIssueTracker implements IssueTracker {
  items: TrackerItem[] = [];

  readonly closers = new Map<number, TrackerPullRequest[]>();

  readonly asked: string[] = [];

  failing = false;

  put(entry: TrackerItem): void {
    this.items = [...this.items.filter(other => other.kind !== entry.kind || other.number !== entry.number), entry];
  }

  async search(repo: TrackerRepoRef, kind: FeedbackLinkKind, query: string, limit: number): Promise<TrackerItem[]> {
    this.asked.push(`${repo.owner}/${repo.name}`);
    return await Promise.resolve(
      this.items
        // eslint-disable-next-line sonarjs/null-dereference -- `query` is a string, never null
        .filter(entry => entry.kind === kind && entry.title.toLowerCase().includes(query.toLowerCase()))
        .slice(0, limit),
    );
  }

  async get(repo: TrackerRepoRef, kind: FeedbackLinkKind, number: number): Promise<TrackerItem | null> {
    this.asked.push(`${repo.owner}/${repo.name}`);
    if (this.failing) {
      throw new Error('provider down');
    }
    return await Promise.resolve(this.items.find(entry => entry.kind === kind && entry.number === number) ?? null);
  }

  async closingPullRequests(repo: TrackerRepoRef, issueNumber: number): Promise<TrackerPullRequest[]> {
    this.asked.push(`${repo.owner}/${repo.name}`);
    return await Promise.resolve(this.closers.get(issueNumber) ?? []);
  }
}

const noCommits: CommitSource = { listCommits: async () => [], getConfigAtCommit: async () => null };

/** The outcome of a call: 'ok', or the error's class name. */
const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return error instanceof Error ? error.name : 'unknown';
  }
};

describe('feedback GitHub links (pglite)', () => {
  let t: TestDb;
  let tracker: FakeIssueTracker;
  let feedback: FeedbackDomain;
  let scope: FeedbackScope;
  let actor: string;
  let postId: string;
  let repoId: string;
  let now: Date;

  /** A workspace with a project, a GitHub connection and a repo; the repo linked to the project
   * unless `isLinked` is false. */
  const workspaceWithRepo = async (externalAccountId: string, externalRepoId: string, isLinked = true) => {
    const workspace = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning());
    const project = await createProjectDomain(t.db).projects.create(workspace.id, { name: 'Acme', handle: 'acme' });
    const connection = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId: workspace.id, provider: 'github', externalAccountId, accountLogin: 'fi-workers' })
        .returning(),
    );
    const repo = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId: workspace.id,
          connectionId: connection.id,
          externalRepoId,
          owner: 'fi-workers',
          name: 'example-repo',
          defaultBranch: 'main',
        })
        .returning(),
    );
    if (isLinked) {
      await t.db.insert(projectRepos).values({ workspaceId: workspace.id, projectId: project.id, repoId: repo.id });
    }
    return { scope: { workspaceId: workspace.id, projectId: project.id }, repoId: repo.id };
  };

  const webhooks = () =>
    new CommitSyncService({
      commits: new CommitRepo(t.db),
      deliveries: new WebhookDeliveryRepo(t.db),
      connections: new ProviderConnectionRepo(t.db),
      repos: new RepoRepo(t.db),
      source: noCommits,
      connectStates: new ConnectStateRepo(t.db),
      configs: new CommitConfigService({
        configs: new CommitConfigRepo(t.db),
        commits: new CommitRepo(t.db),
        source: noCommits,
        parser: new MoccoConfigParser(decodeYaml),
      }),
    }).withTrackerEvents(feedback.feedbackLinks);

  beforeEach(async () => {
    t = await createTestDb();
    tracker = new FakeIssueTracker();
    now = NOW;
    feedback = createFeedbackDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      now: () => now,
      tracker,
    });
    ({ scope, repoId } = await workspaceWithRepo(INSTALLATION_ID, EXTERNAL_REPO_ID));
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const board = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'ideas', name: 'Ideas' });
    ({ id: postId } = await feedback.feedbackPosts.create(scope, actor, { boardId: board.id, title: 'Dark mode' }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  it('lists the project repos and searches one of them', async () => {
    tracker.put(item(FeedbackLinkKinds.issue, 12, { title: 'Dark mode' }));
    tracker.put(item(FeedbackLinkKinds.pullRequest, 42, { title: 'Add dark mode' }));

    expect(await feedback.feedbackLinks.repos(scope)).toEqual([
      { id: repoId, owner: 'fi-workers', name: 'example-repo' },
    ]);
    const found = await feedback.feedbackLinks.search(
      scope,
      { repoId, kind: FeedbackLinkKinds.pullRequest, query: 'dark' },
      10,
    );
    expect(found.map(entry => entry.number)).toEqual([42]);
  });

  it('links an issue with the pull requests that close it, once, and audits it', async () => {
    tracker.put(item(FeedbackLinkKinds.issue, 12, { title: 'Dark mode' }));
    tracker.closers.set(12, [pull(42), pull(43, { state: FeedbackLinkStates.closed })]);

    const link = await feedback.feedbackLinks.link(scope, actor, postId, {
      repoId,
      kind: FeedbackLinkKinds.issue,
      number: 12,
    });
    expect(link).toMatchObject({ kind: FeedbackLinkKinds.issue, externalNumber: 12, state: FeedbackLinkStates.open });

    const [listed] = await feedback.feedbackLinks.list(scope, postId);
    expect(listed?.repo).toEqual({ owner: 'fi-workers', name: 'example-repo' });
    expect(listed?.closers.map(closer => [closer.prNumber, closer.state])).toEqual([
      [42, FeedbackLinkStates.open],
      [43, FeedbackLinkStates.closed],
    ]);
    expect(
      await outcome(
        async () =>
          await feedback.feedbackLinks.link(scope, actor, postId, {
            repoId,
            kind: FeedbackLinkKinds.issue,
            number: 12,
          }),
      ),
    ).toBe('FeedbackLinkExistsError');
    expect(
      await outcome(
        async () =>
          await feedback.feedbackLinks.link(scope, actor, postId, {
            repoId,
            kind: FeedbackLinkKinds.issue,
            number: 99,
          }),
      ),
    ).toBe('FeedbackLinkTargetNotFoundError');
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, AuditActions.feedbackPostLinked));
    expect(audit.map(row => row.payload)).toEqual([
      expect.objectContaining({ repo: 'fi-workers/example-repo', kind: FeedbackLinkKinds.issue, externalNumber: 12 }),
    ]);

    await feedback.feedbackLinks.unlink(scope, actor, link.id);
    expect(await feedback.feedbackLinks.list(scope, postId)).toEqual([]);
    expect(await t.db.select().from(feedbackLinkClosers)).toEqual([]);
    expect(await outcome(async () => await feedback.feedbackLinks.unlink(scope, actor, link.id))).toBe(
      'FeedbackLinkNotFoundError',
    );
  });

  it("refuses a repo outside the post's project or workspace, in the service and in the schema", async () => {
    tracker.put(item(FeedbackLinkKinds.issue, 12));
    const other = await workspaceWithRepo('999', '777');
    const unlinked = await workspaceWithRepo('998', '778', false);
    const sameWorkspaceUnlinked = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId: scope.workspaceId,
          connectionId: expectOne(
            await t.db.select().from(providerConnections).where(eq(providerConnections.workspaceId, scope.workspaceId)),
          ).id,
          externalRepoId: '555',
          owner: 'fi-workers',
          name: 'private-notes',
          defaultBranch: 'main',
        })
        .returning(),
    );

    const attempts = await Promise.all(
      [other.repoId, unlinked.repoId, sameWorkspaceUnlinked.id].map(
        async foreignRepoId =>
          await outcome(
            async () =>
              await feedback.feedbackLinks.link(scope, actor, postId, {
                repoId: foreignRepoId,
                kind: FeedbackLinkKinds.issue,
                number: 12,
              }),
          ),
      ),
    );
    expect(attempts).toEqual(Array.from({ length: 3 }, () => 'FeedbackLinkRepoNotFoundError'));
    expect(
      await outcome(
        async () =>
          await feedback.feedbackLinks.search(
            scope,
            { repoId: other.repoId, kind: FeedbackLinkKinds.issue, query: '' },
            5,
          ),
      ),
    ).toBe('FeedbackLinkRepoNotFoundError');
    // The provider was never asked about a repo the project doesn't link.
    expect(tracker.asked).toEqual([]);

    // A direct insert can't pair this workspace's post with another workspace's repo either.
    await expect(
      t.db.insert(feedbackLinks).values({
        ...scope,
        postId,
        repoId: other.repoId,
        kind: FeedbackLinkKinds.issue,
        externalNumber: 12,
        externalNodeId: 'I_12',
        title: 'x',
        url: 'https://github.com/x/y/issues/12',
        state: FeedbackLinkStates.open,
      }),
    ).rejects.toThrow();
  });

  it('a closed-and-merged pull_request delivery sets merged and the merge commit', async () => {
    tracker.put(item(FeedbackLinkKinds.pullRequest, 42, { title: 'Add dark mode' }));
    tracker.put(item(FeedbackLinkKinds.issue, 12));
    tracker.closers.set(12, [pull(42)]);
    await feedback.feedbackLinks.link(scope, actor, postId, {
      repoId,
      kind: FeedbackLinkKinds.pullRequest,
      number: 42,
    });
    await feedback.feedbackLinks.link(scope, actor, postId, { repoId, kind: FeedbackLinkKinds.issue, number: 12 });

    await webhooks().handle(parseWebhook('pull_request', readFixture('pull-request-closed-merged.json')));

    const links = await feedback.feedbackLinks.list(scope, postId);
    const pr = links.find(link => link.kind === FeedbackLinkKinds.pullRequest);
    expect(pr).toMatchObject({
      state: FeedbackLinkStates.merged,
      mergeCommitSha: 'c0ffee0000000000000000000000000000000042',
      mergedAt: new Date('2026-10-17T09:30:00Z'),
      refreshedAt: NOW,
    });
    // The issue's closer for the same pull request follows it.
    const issue = links.find(link => link.kind === FeedbackLinkKinds.issue);
    expect(issue?.closers).toEqual([
      expect.objectContaining({
        prNumber: 42,
        state: FeedbackLinkStates.merged,
        mergeCommitSha: 'c0ffee0000000000000000000000000000000042',
      }),
    ]);
  });

  it('an issues delivery updates the link and resolves its closing pull requests again', async () => {
    tracker.put(item(FeedbackLinkKinds.issue, 12));
    await feedback.feedbackLinks.link(scope, actor, postId, { repoId, kind: FeedbackLinkKinds.issue, number: 12 });
    tracker.closers.set(12, [pull(50, { state: FeedbackLinkStates.merged, mergeCommitSha: 'abc' })]);

    await webhooks().handle(parseWebhook('issues', readFixture('issues-closed.json')));

    const [link] = await feedback.feedbackLinks.list(scope, postId);
    expect(link).toMatchObject({ state: FeedbackLinkStates.closed, title: 'Dark mode' });
    expect(link?.closers.map(closer => [closer.prNumber, closer.mergeCommitSha])).toEqual([[50, 'abc']]);
  });

  it('parks deliveries for unlinked pull requests, unregistered repos and unknown installations', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const merged = JSON.parse(readFixture('pull-request-closed-merged.json')) as Record<string, unknown>;
    const deliveries = [
      merged,
      { ...merged, repository: { id: 111, name: 'other', owner: { login: 'fi-workers' } } },
      { ...merged, installation: { id: 1 } },
    ];

    await deliveries.reduce(async (previous, body) => {
      await previous;
      await expect(webhooks().handle(parseWebhook('pull_request', JSON.stringify(body)))).resolves.toBeUndefined();
    }, Promise.resolve());

    expect(await t.db.select().from(feedbackLinks)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not linked — parked'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unregistered repo 111'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unconnected installation 1'));
  });

  it("another workspace's delivery for the same GitHub repo never touches this workspace's links", async () => {
    tracker.put(item(FeedbackLinkKinds.pullRequest, 42));
    await feedback.feedbackLinks.link(scope, actor, postId, {
      repoId,
      kind: FeedbackLinkKinds.pullRequest,
      number: 42,
    });
    // Another workspace registered the same GitHub repo under its own installation.
    await workspaceWithRepo('87654321', EXTERNAL_REPO_ID);
    const merged = JSON.parse(readFixture('pull-request-closed-merged.json')) as Record<string, unknown>;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await webhooks().handle(
      parseWebhook('pull_request', JSON.stringify({ ...merged, installation: { id: 87_654_321 } })),
    );

    const [link] = await feedback.feedbackLinks.list(scope, postId);
    expect(link?.state).toBe(FeedbackLinkStates.open);
  });

  it('the refresh job reads stale links again and moves past failures', async () => {
    tracker.put(item(FeedbackLinkKinds.pullRequest, 42));
    tracker.put(item(FeedbackLinkKinds.issue, 12));
    await feedback.feedbackLinks.link(scope, actor, postId, {
      repoId,
      kind: FeedbackLinkKinds.pullRequest,
      number: 42,
    });
    await feedback.feedbackLinks.link(scope, actor, postId, { repoId, kind: FeedbackLinkKinds.issue, number: 12 });
    // Missed deliveries: both changed on GitHub.
    tracker.put(item(FeedbackLinkKinds.pullRequest, 42, { state: FeedbackLinkStates.merged, mergeCommitSha: 'f00d' }));
    tracker.put(item(FeedbackLinkKinds.issue, 12, { state: FeedbackLinkStates.closed }));
    tracker.closers.set(12, [pull(42, { state: FeedbackLinkStates.merged, mergeCommitSha: 'f00d' })]);

    expect(await feedback.feedbackLinks.refreshStale()).toBe(0); // fresh: nothing due yet
    now = new Date(NOW.getTime() + LinkRefreshPolicy.staleAfterMs + 1000);
    expect(await feedback.feedbackLinks.refreshStale()).toBe(2);

    const links = await feedback.feedbackLinks.list(scope, postId);
    expect(links.map(link => [link.kind, link.state, link.mergeCommitSha])).toEqual([
      [FeedbackLinkKinds.pullRequest, FeedbackLinkStates.merged, 'f00d'],
      [FeedbackLinkKinds.issue, FeedbackLinkStates.closed, null],
    ]);
    expect(links[1]?.closers.map(closer => closer.prNumber)).toEqual([42]);

    // A failing provider is logged, and the links wait their next turn instead of blocking the run.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    tracker.failing = true;
    now = new Date(now.getTime() + LinkRefreshPolicy.staleAfterMs + 1000);
    expect(await feedback.feedbackLinks.refreshStale()).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
    expect(await feedback.feedbackLinks.refreshStale()).toBe(0);
  });

  it('without a GitHub App, links still list but none can be made', async () => {
    const bare = createFeedbackDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }) });
    expect(
      await outcome(
        async () =>
          await bare.feedbackLinks.link(scope, actor, postId, { repoId, kind: FeedbackLinkKinds.issue, number: 1 }),
      ),
    ).toBe('FeedbackIssueTrackerUnavailableError');
    expect(await bare.feedbackLinks.list(scope, postId)).toEqual([]);
    expect(await bare.feedbackLinks.refreshStale()).toBe(0);
  });
});
