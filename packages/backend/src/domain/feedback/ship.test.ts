import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { DomainEventTypes, FeedbackEventTypes } from '@mocco/common/events';
import {
  ChangelogEntryStates,
  FeedbackLinkKinds,
  FeedbackLinkStates,
  FeedbackPostStatuses,
  FeedbackStatusChangeReasons,
  ShipModes,
  ShipPolicies,
  ShipSuggestionStates,
} from '@mocco/common/feedback';
import { Severities } from '@mocco/common/notification';
import { rulePresetRules } from '@mocco/common/notification-presets';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createEventBus } from '@backend/domain/events/subscriptions';
import { AncestryChecks } from '@backend/domain/feedback/ancestry-checks';
import { createFeedbackDomain, createShipDetector } from '@backend/domain/feedback/compose';
import { SHIP_DETECT_SUBSCRIBER } from '@backend/domain/feedback/subscribers';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { NotificationSubscribers } from '@backend/domain/notification/constants';
import { seedChannel, seedRule } from '@backend/domain/notification/testing/seed';
import { createProjectDomain } from '@backend/domain/project/instance';
import { seedRepo, seedRun } from '@backend/domain/status/testing/deploys';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  changelogEntries,
  commits,
  domainEvents,
  feedbackLinkClosers,
  feedbackLinks,
  feedbackShipSuggestions,
  feedbackStatusChanges,
  notificationDeliveries,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { PublishInput } from '@backend/domain/events/EventBus';
import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { ShippingRelease } from '@backend/domain/feedback/ShipDetector';
import type { CommitAncestry, TrackerRepoRef } from '@backend/domain/integration/ports';
import type { FeedbackReleasePolicyInput } from '@mocco/common/feedback';

const NOW = new Date('2026-10-17T12:00:00Z');
const APP_ORIGIN = 'https://mocco.test';

/**
 * The CommitAncestry port over an in-memory history: each head lists the commits reachable from
 * it. Records every question, so a test can count the calls the detector made.
 */
class FakeCommitAncestry implements CommitAncestry {
  readonly history = new Map<string, Set<string>>();

  readonly asked: string[] = [];

  failing = false;

  /** `head`'s history is `ancestors` (and itself). */
  commit(head: string, ancestors: readonly string[]): void {
    this.history.set(head, new Set([head, ...ancestors]));
  }

  async containsCommit(_repo: TrackerRepoRef, ancestorSha: string, headSha: string): Promise<boolean> {
    this.asked.push(`${ancestorSha}...${headSha}`);
    if (this.failing) {
      throw new Error('GitHub is down');
    }
    return await Promise.resolve(this.history.get(headSha)?.has(ancestorSha) ?? false);
  }
}

describe('AncestryChecks', () => {
  const repo = { externalAccountId: '1', owner: 'acme', name: 'api' };

  it('answers the same commit without asking, caches answers and stops at the cap', async () => {
    const ancestry = new FakeCommitAncestry();
    ancestry.commit('head', ['a', 'b']);
    const checks = new AncestryChecks(ancestry, repo, 2);

    expect(await checks.contains('head', 'head')).toBe(true);
    expect(await checks.contains('a', 'head')).toBe(true);
    expect(await checks.contains('a', 'head')).toBe(true);
    expect(await checks.contains('gone', 'head')).toBe(false);
    // The cap is reached: unknown, and GitHub isn't asked.
    expect(await checks.contains('b', 'head')).toBeUndefined();
    expect(ancestry.asked).toEqual(['a...head', 'gone...head']);
    expect(checks.callCount).toBe(2);
  });

  it('is unknown without GitHub or when GitHub fails', async () => {
    expect(await new AncestryChecks(undefined, repo, 5).contains('a', 'head')).toBeUndefined();
    const failing = new FakeCommitAncestry();
    failing.failing = true;
    expect(await new AncestryChecks(failing, repo, 5).contains('a', 'head')).toBeUndefined();
  });
});

describe('shipping posts on release (pglite)', () => {
  let t: TestDb;
  let feedback: FeedbackDomain;
  let ancestry: FakeCommitAncestry;
  let scope: FeedbackScope;
  let repoId: string;
  let actor: string;
  let boardId: string;
  let now: Date;

  const audit = () => new AuditService({ audit: new AuditRepo(t.db) });
  const detector = () => createShipDetector(t.db, { audit: audit(), ancestry, now: () => now });

  const policy = async (input: Partial<FeedbackReleasePolicyInput>) =>
    await feedback.feedbackBoards.setReleasePolicy(scope, actor, boardId, {
      releaseRepoId: repoId,
      releaseStepName: null,
      shipPolicy: ShipPolicies.allLinksShipped,
      shipMode: ShipModes.suggest,
      ...input,
    });

  const post = async (title: string) =>
    await feedback.feedbackPosts.create(scope, actor, { boardId, title, status: FeedbackPostStatuses.inProgress });

  /** A link to pull request `number` of the release repo, merged at `mergeSha` unless null (open). */
  const pullLink = async (postId: string, number: number, mergeSha: string | null) =>
    expectOne(
      await t.db
        .insert(feedbackLinks)
        .values({
          ...scope,
          postId,
          repoId,
          kind: FeedbackLinkKinds.pullRequest,
          externalNumber: number,
          externalNodeId: `PR_${String(number)}`,
          title: `Pull request ${String(number)}`,
          url: `https://github.com/acme/api/pull/${String(number)}`,
          state: mergeSha === null ? FeedbackLinkStates.open : FeedbackLinkStates.merged,
          mergeCommitSha: mergeSha,
          mergedAt: mergeSha === null ? null : now,
        })
        .returning(),
    );

  /** A release run of the repo at a fresh commit `sha` (seeded), and what its event says. */
  const release = async (overrides: Partial<ShippingRelease> = {}): Promise<ShippingRelease> => {
    const run = await seedRun(t.db, { workspaceId: scope.workspaceId, repoId, finishedAt: now });
    return {
      workspaceId: scope.workspaceId,
      runId: run.runId,
      repoId,
      projectIds: [scope.projectId],
      commitSha: run.sha,
      gateNames: ['production'],
      succeededSteps: ['build', 'deploy'],
      ...overrides,
    };
  };

  const suggestionsOf = async (postId: string) =>
    await t.db.select().from(feedbackShipSuggestions).where(eq(feedbackShipSuggestions.postId, postId));

  const linkRow = async (id: string) =>
    expectOne(await t.db.select().from(feedbackLinks).where(eq(feedbackLinks.id, id)));

  /** The run that shipped the link, or null. */
  const shippedRunOf = async (linkId: string) => {
    const link = await linkRow(linkId);
    return link.shippedRunId;
  };

  /** The posts the release suggests now. */
  const suggestedPosts = async (shipped: ShippingRelease) => {
    const rows = await detector().detect(shipped);
    return rows.map(row => row.postId);
  };

  const statusOf = async (postId: string) => {
    const { post: row } = await feedback.feedbackPosts.get(scope, postId);
    return row.status;
  };

  const firstSuggestion = async (postId: string) => {
    const [row] = await suggestionsOf(postId);
    return row;
  };

  /** A bus with every subscriber, whose kicks run nothing: the test hands events over itself. */
  const eventBus = () =>
    createEventBus({
      db: t.db,
      queue: new PostgresJobQueue({
        jobs: new JobRepo(t.db),
        now: () => now,
        runOne: async () => await Promise.resolve(null),
        waitUntil: () => {},
      }),
      now: () => now,
      appOrigin: APP_ORIGIN,
      commitAncestry: ancestry,
    });

  /** The detector with the staff notice wired to a fresh bus. */
  const announcing = () =>
    createShipDetector(t.db, { audit: audit(), ancestry, events: eventBus(), appOrigin: APP_ORIGIN, now: () => now });

  /** The staff notices published in the workspace. */
  const notices = async () =>
    await t.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.workspaceId, scope.workspaceId),
          eq(domainEvents.type, FeedbackEventTypes.feedbackShipSuggested),
        ),
      );

  const auditActions = async () => {
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.workspaceId, scope.workspaceId));
    return rows.map(row => row.action);
  };

  beforeEach(async () => {
    t = await createTestDb();
    now = NOW;
    ancestry = new FakeCommitAncestry();
    feedback = createFeedbackDomain(t.db, { audit: audit(), now: () => now });
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId, projectId: project.id };
    repoId = await seedRepo(t.db, workspaceId, 'api', [project.id]);
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const board = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'ideas', name: 'Ideas' });
    boardId = board.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('defaults to no release repo, asking the team, and all links shipped', async () => {
    const { board } = await feedback.feedbackBoards.getBoard(scope, boardId);
    expect(board).toMatchObject({
      releaseRepoId: null,
      releaseStepName: null,
      shipPolicy: ShipPolicies.allLinksShipped,
      shipMode: ShipModes.suggest,
    });
    // Without a release repo, no release ships the board's posts.
    const dark = await post('Dark mode');
    const shipped = await release();
    await pullLink(dark.id, 1, shipped.commitSha);
    expect(await detector().detect(shipped)).toEqual([]);
  });

  it('suggests a post whose merge commit is the released commit, without asking GitHub', async () => {
    await policy({});
    const dark = await post('Dark mode');
    const shipped = await release();
    const link = await pullLink(dark.id, 1, shipped.commitSha);

    const suggested = await detector().detect(shipped);

    expect(suggested).toMatchObject([
      {
        postId: dark.id,
        runId: shipped.runId,
        commitSha: shipped.commitSha,
        gateNames: ['production'],
        state: ShipSuggestionStates.pending,
      },
    ]);
    expect(ancestry.asked).toEqual([]);
    expect(await linkRow(link.id)).toMatchObject({ shippedRunId: shipped.runId, shippedAt: now });
    // Suggest is the default: the post waits for the team.
    expect(await statusOf(dark.id)).toBe(FeedbackPostStatuses.inProgress);
    const [entry] = await t.db.select().from(changelogEntries);
    expect(entry).toMatchObject({
      sourceRunId: shipped.runId,
      state: ChangelogEntryStates.draft,
      title: 'Dark mode',
      bodyMd: '- Dark mode ([#1](https://github.com/acme/api/pull/1))',
      createdByUserId: null,
    });
    expect(suggested[0]?.changelogEntryId).toBeNull();
    expect(await firstSuggestion(dark.id)).toMatchObject({ changelogEntryId: entry?.id });
    const [suggestedAudit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AuditActions.feedbackShippedSuggested));
    expect(suggestedAudit).toMatchObject({ actorUserId: null, subjectId: dark.id });
    expect(suggestedAudit?.payload).toMatchObject({ runId: shipped.runId, gates: ['production'], number: dark.number });
  });

  it('asks GitHub for a merge commit behind the release: ancestor, not contained, and force-pushed away', async () => {
    await policy({});
    const ancestorPost = await post('Ancestor');
    const strangerPost = await post('Not contained');
    const forcedPost = await post('Force-pushed away');
    const shipped = await release();
    // The force-pushed merge is still in mocco_commits on the branch, older than the release: the
    // commit order says it is in the release, but after the force-push the history doesn't have it.
    await t.db.insert(commits).values({
      repoId,
      sha: 'forced',
      branch: 'main',
      message: 'Merge pull request #3',
      authorName: 'A',
      authorEmail: 'a@acme.test',
      committedAt: new Date(now.getTime() - 60_000),
    });
    ancestry.commit(shipped.commitSha, ['merged-before']);
    const ancestor = await pullLink(ancestorPost.id, 1, 'merged-before');
    const stranger = await pullLink(strangerPost.id, 2, 'on-another-branch');
    const forced = await pullLink(forcedPost.id, 3, 'forced');

    const suggested = await detector().detect(shipped);

    expect(suggested.map(row => row.postId)).toEqual([ancestorPost.id]);
    expect(new Set(ancestry.asked)).toEqual(
      new Set(['merged-before', 'on-another-branch', 'forced'].map(sha => `${sha}...${shipped.commitSha}`)),
    );
    expect(await shippedRunOf(ancestor.id)).toBe(shipped.runId);
    expect(await shippedRunOf(stranger.id)).toBeNull();
    expect(await shippedRunOf(forced.id)).toBeNull();

    // A later release whose history has the commit ships it then; the first release stays on the first link.
    const later = await release();
    ancestry.commit(later.commitSha, ['merged-before', 'on-another-branch']);
    expect(await suggestedPosts(later)).toEqual([strangerPost.id]);
    expect(await shippedRunOf(ancestor.id)).toBe(shipped.runId);
  });

  it('ships an issue through the merge commit of a pull request closing it', async () => {
    await policy({});
    const dark = await post('Dark mode');
    const shipped = await release();
    const issue = expectOne(
      await t.db
        .insert(feedbackLinks)
        .values({
          ...scope,
          postId: dark.id,
          repoId,
          kind: FeedbackLinkKinds.issue,
          externalNumber: 10,
          externalNodeId: 'I_10',
          title: 'Dark mode',
          url: 'https://github.com/acme/api/issues/10',
          state: FeedbackLinkStates.closed,
        })
        .returning(),
    );
    await t.db.insert(feedbackLinkClosers).values({
      workspaceId: scope.workspaceId,
      linkId: issue.id,
      repoId,
      prNumber: 11,
      externalNodeId: 'PR_11',
      title: 'Add dark mode',
      url: 'https://github.com/acme/api/pull/11',
      state: FeedbackLinkStates.merged,
      mergeCommitSha: shipped.commitSha,
      mergedAt: now,
    });

    expect(await suggestedPosts(shipped)).toEqual([dark.id]);
    expect(await shippedRunOf(issue.id)).toBe(shipped.runId);
    const [entry] = await t.db.select().from(changelogEntries);
    expect(entry?.bodyMd).toBe('- Dark mode ([#11](https://github.com/acme/api/pull/11))');
  });

  it('counts only releases whose run succeeded the board release step', async () => {
    await policy({ releaseStepName: 'deploy-prod' });
    const dark = await post('Dark mode');

    const staging = await release({ succeededSteps: ['build', 'deploy-staging'] });
    await pullLink(dark.id, 1, staging.commitSha);
    expect(await detector().detect(staging)).toEqual([]);

    const production = await release({ succeededSteps: ['build', 'deploy-prod'] });
    ancestry.commit(production.commitSha, [staging.commitSha]);
    expect(await suggestedPosts(production)).toEqual([dark.id]);
  });

  it("ignores another project's board and a release not recorded for the board's project", async () => {
    await policy({});
    const dark = await post('Dark mode');
    const shipped = await release({ projectIds: [randomUUID()] });
    await pullLink(dark.id, 1, shipped.commitSha);
    expect(await detector().detect(shipped)).toEqual([]);
  });

  it('waits for every link under all_links_shipped, and takes one under any_link_shipped', async () => {
    await policy({ shipPolicy: ShipPolicies.allLinksShipped });
    const dark = await post('Dark mode');
    const first = await release();
    await pullLink(dark.id, 1, first.commitSha);
    const open = await pullLink(dark.id, 2, null);
    // A pull request closed without merging is abandoned and doesn't hold the post back.
    await t.db.insert(feedbackLinks).values({
      ...scope,
      postId: dark.id,
      repoId,
      kind: FeedbackLinkKinds.pullRequest,
      externalNumber: 3,
      externalNodeId: 'PR_3',
      title: 'Abandoned',
      url: 'https://github.com/acme/api/pull/3',
      state: FeedbackLinkStates.closed,
    });

    expect(await detector().detect(first)).toEqual([]);

    // The second pull request merges and a later release contains both.
    const second = await release();
    await t.db
      .update(feedbackLinks)
      .set({ state: FeedbackLinkStates.merged, mergeCommitSha: second.commitSha })
      .where(eq(feedbackLinks.id, open.id));
    const suggested = await detector().detect(second);
    expect(suggested.map(row => [row.postId, row.runId])).toEqual([[dark.id, second.runId]]);

    // any_link_shipped suggests at the first shipped link.
    await policy({ shipPolicy: ShipPolicies.anyLinkShipped });
    const light = await post('Light mode');
    const third = await release();
    await pullLink(light.id, 4, third.commitSha);
    await pullLink(light.id, 5, null);
    expect(await suggestedPosts(third)).toEqual([light.id]);
  });

  it('suggests once per post and run when the release is handled again', async () => {
    await policy({});
    const dark = await post('Dark mode');
    const shipped = await release();
    await pullLink(dark.id, 1, shipped.commitSha);

    expect(await detector().detect(shipped)).toHaveLength(1);
    expect(await detector().detect(shipped)).toEqual([]);

    expect(await suggestionsOf(dark.id)).toHaveLength(1);
    expect(await t.db.select().from(changelogEntries)).toHaveLength(1);
    const actions = await auditActions();
    expect(actions.filter(action => action === AuditActions.feedbackShippedSuggested)).toHaveLength(1);
  });

  it('does not suggest a post that waits on a suggestion from an earlier run, or is shipped already', async () => {
    await policy({ shipPolicy: ShipPolicies.anyLinkShipped });
    const dark = await post('Dark mode');
    const first = await release();
    await pullLink(dark.id, 1, first.commitSha);
    expect(await detector().detect(first)).toHaveLength(1);

    const second = await release();
    await pullLink(dark.id, 2, second.commitSha);
    expect(await detector().detect(second)).toEqual([]);

    const done = await post('Done');
    await feedback.feedbackPosts.setStatus(scope, actor, done.id, FeedbackPostStatuses.shipped);
    const third = await release();
    await pullLink(done.id, 3, third.commitSha);
    expect(await detector().detect(third)).toEqual([]);
  });

  it('groups every post a run shipped in one draft that records the run', async () => {
    await policy({});
    const dark = await post('Dark mode');
    const csv = await post('Export CSV');
    const shipped = await release();
    ancestry.commit(shipped.commitSha, ['csv-merge']);
    await pullLink(dark.id, 1, shipped.commitSha);
    await pullLink(csv.id, 2, 'csv-merge');

    await detector().detect(shipped);

    const entries = await t.db.select().from(changelogEntries);
    expect(entries).toHaveLength(1);
    const entry = await feedback.feedbackChangelog.get(scope, entries[0]?.id ?? '');
    expect(entry).toMatchObject({ sourceRunId: shipped.runId, title: 'Dark mode and 1 more', state: 'draft' });
    expect(entry.postIds).toEqual([dark.id, csv.id]);
    expect(entry.bodyMd).toBe(
      '- Dark mode ([#1](https://github.com/acme/api/pull/1))\n- Export CSV ([#2](https://github.com/acme/api/pull/2))',
    );
    const suggestions = await t.db
      .select()
      .from(feedbackShipSuggestions)
      .where(eq(feedbackShipSuggestions.runId, shipped.runId));
    expect(suggestions.map(row => row.changelogEntryId)).toEqual([entry.id, entry.id]);
  });

  it('stops asking GitHub at the per-release cap; the rest wait for a later release', async () => {
    await policy({});
    const shipped = await release();
    ancestry.commit(shipped.commitSha, ['m1', 'm2', 'm3']);
    const posts = [await post('One'), await post('Two'), await post('Three')];
    await Promise.all(posts.map(async (row, index) => await pullLink(row.id, index + 1, `m${String(index + 1)}`)));

    const suggested = await createShipDetector(t.db, {
      audit: audit(),
      ancestry,
      now: () => now,
      ancestryCallCap: 2,
    }).detect(shipped);

    expect(ancestry.asked).toHaveLength(2);
    expect(suggested).toHaveLength(2);
  });

  it('accepts as the team member: the posts ship with reason ship_suggestion and the mail follows', async () => {
    await policy({});
    const dark = await post('Dark mode');
    const csv = await post('Export CSV');
    const shipped = await release();
    await pullLink(dark.id, 1, shipped.commitSha);
    await pullLink(csv.id, 2, shipped.commitSha);
    await detector().detect(shipped);

    const [pending] = await feedback.feedbackShipSuggestions.listPending(scope, boardId);
    expect(pending).toMatchObject({ runId: shipped.runId, commitSha: shipped.commitSha, gateNames: ['production'] });
    expect(pending?.posts.map(row => row.id)).toEqual([dark.id, csv.id]);

    now = new Date(NOW.getTime() + 60_000);
    expect(await feedback.feedbackShipSuggestions.accept(scope, actor, boardId, shipped.runId)).toEqual({ shipped: 2 });

    const { post: shippedPost, history } = await feedback.feedbackPosts.get(scope, dark.id);
    expect(shippedPost).toMatchObject({ status: FeedbackPostStatuses.shipped, shippedAt: now });
    // The change waits for the status mail job like any other (notified_at null).
    expect(history.at(-1)).toMatchObject({
      fromStatus: FeedbackPostStatuses.inProgress,
      toStatus: FeedbackPostStatuses.shipped,
      reason: FeedbackStatusChangeReasons.shipSuggestion,
      actorUserId: actor,
      notifiedAt: null,
    });
    expect(await firstSuggestion(dark.id)).toMatchObject({
      state: ShipSuggestionStates.accepted,
      decidedByUserId: actor,
      decidedAt: now,
    });
    const shippedAudits = await t.db.select().from(auditLog).where(eq(auditLog.action, AuditActions.feedbackShipped));
    expect(new Set(shippedAudits.map(row => `${row.subjectId}:${String(row.actorUserId)}`))).toEqual(
      new Set([`${dark.id}:${actor}`, `${csv.id}:${actor}`]),
    );
    expect(await feedback.feedbackShipSuggestions.listPending(scope, boardId)).toEqual([]);
    await expect(feedback.feedbackShipSuggestions.accept(scope, actor, boardId, shipped.runId)).rejects.toMatchObject({
      name: 'FeedbackShipSuggestionNotFoundError',
    });
  });

  it('dismisses without changing the posts', async () => {
    await policy({});
    const dark = await post('Dark mode');
    const shipped = await release();
    await pullLink(dark.id, 1, shipped.commitSha);
    await detector().detect(shipped);

    expect(await feedback.feedbackShipSuggestions.dismiss(scope, actor, boardId, shipped.runId)).toEqual({
      dismissed: 1,
    });
    expect(await statusOf(dark.id)).toBe(FeedbackPostStatuses.inProgress);
    expect(await firstSuggestion(dark.id)).toMatchObject({ state: ShipSuggestionStates.dismissed });
    await expect(feedback.feedbackShipSuggestions.dismiss(scope, actor, boardId, shipped.runId)).rejects.toMatchObject({
      name: 'FeedbackShipSuggestionNotFoundError',
    });
  });

  it('applies on its own in auto_apply mode, with reason auto_apply and no actor', async () => {
    await policy({ shipMode: ShipModes.autoApply });
    const dark = await post('Dark mode');
    const shipped = await release();
    await pullLink(dark.id, 1, shipped.commitSha);

    await detector().detect(shipped);

    const { post: shippedPost, history } = await feedback.feedbackPosts.get(scope, dark.id);
    expect(shippedPost.status).toBe(FeedbackPostStatuses.shipped);
    expect(history.at(-1)).toMatchObject({
      toStatus: FeedbackPostStatuses.shipped,
      reason: FeedbackStatusChangeReasons.autoApply,
      actorUserId: null,
    });
    expect(await firstSuggestion(dark.id)).toMatchObject({
      state: ShipSuggestionStates.autoApplied,
      decidedByUserId: null,
    });
    const [shippedAudit] = await t.db.select().from(auditLog).where(eq(auditLog.action, AuditActions.feedbackShipped));
    expect(shippedAudit).toMatchObject({ actorUserId: null, subjectId: dark.id });
    expect(shippedAudit?.payload).toMatchObject({ reason: FeedbackStatusChangeReasons.autoApply });
    // The draft stays a draft: publishing it is the team's call.
    const [entry] = await t.db.select().from(changelogEntries);
    expect(entry?.state).toBe(ChangelogEntryStates.draft);
    expect(await feedback.feedbackShipSuggestions.listPending(scope, boardId)).toEqual([]);
  });

  it('refuses a release repo the project does not link', async () => {
    const otherRepo = await seedRepo(t.db, scope.workspaceId, 'web');
    await expect(policy({ releaseRepoId: otherRepo })).rejects.toMatchObject({
      name: 'FeedbackLinkRepoNotFoundError',
    });
    const changed = await policy({ shipMode: ShipModes.autoApply, releaseStepName: 'deploy' });
    expect(changed).toMatchObject({ releaseRepoId: repoId, releaseStepName: 'deploy', shipMode: ShipModes.autoApply });
    expect(await auditActions()).toContain(AuditActions.feedbackBoardReleasePolicyChanged);
  });

  it('announces the posts waiting for the team once per board and run', async () => {
    await policy({});
    const dark = await post('Dark mode');
    const csv = await post('Export CSV');
    const shipped = await release({ gateNames: ['sre', 'production'] });
    await pullLink(dark.id, 1, shipped.commitSha);
    await pullLink(csv.id, 2, shipped.commitSha);

    await announcing().detect(shipped);
    // The release handled again (a redelivery, the hourly reconcile) announces nothing new.
    await announcing().detect(shipped);

    const sent = await notices();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      projectId: scope.projectId,
      subjectType: 'feedback_board',
      subjectId: boardId,
      dedupeKey: `feedback.ship.suggested:${boardId}:${shipped.runId}`,
    });
    const sha = shipped.commitSha.slice(0, 7);
    expect(sent[0]?.payload).toEqual({
      facts: { board: 'ideas' },
      message: {
        title: `2 posts shipped on Ideas in run ${sha}`,
        url: `${APP_ORIGIN}/workspaces/${scope.workspaceId}/p/${scope.projectId}/feedback?board=ideas`,
        description: `• #${String(dark.number)} Dark mode\n• #${String(csv.number)} Export CSV\n\nMark them shipped in the inbox to tell the people who voted.`,
        severity: Severities.info,
        fields: [
          { name: 'Board', value: 'Ideas', inline: true },
          { name: 'Posts', value: '2', inline: true },
          { name: 'Commit', value: sha, inline: true },
          { name: 'Approved by', value: 'sre, production', inline: false },
        ],
        footer: 'Mocco feedback',
      },
    });
  });

  it('sends no notice when nothing waits: auto-applied posts, or a run that shipped nothing', async () => {
    await policy({ shipMode: ShipModes.autoApply });
    const dark = await post('Dark mode');
    const shipped = await release();
    await pullLink(dark.id, 1, shipped.commitSha);

    expect(await announcing().detect(shipped)).toHaveLength(1);
    expect(await statusOf(dark.id)).toBe(FeedbackPostStatuses.shipped);
    expect(await announcing().detect(await release())).toEqual([]);

    expect(await notices()).toEqual([]);
  });

  it('runs from deploy.released through the bus subscriber, once per event', async () => {
    await policy({});
    const dark = await post('Dark mode');
    const shipped = await release();
    ancestry.commit(shipped.commitSha, ['merged']);
    await pullLink(dark.id, 1, 'merged');
    // A channel that applied the Mocco preset gets the staff notice.
    const channel = await seedChannel(t.db, scope.workspaceId, 'product');
    const presetRule = rulePresetRules.mocco.find(rule => rule.eventType === FeedbackEventTypes.feedbackShipSuggested);
    expect(presetRule).toBeDefined();
    await seedRule(t.db, channel, { eventType: presetRule?.eventType ?? '', filter: presetRule?.filter ?? {} });
    const bus = eventBus();
    const releasedEvent: Extract<PublishInput, { type: typeof DomainEventTypes.deployReleased }> = {
      type: DomainEventTypes.deployReleased,
      workspaceId: scope.workspaceId,
      subject: { type: 'run', id: shipped.runId },
      dedupeKey: `deploy.released:${shipped.runId}`,
      payload: {
        workspaceId: scope.workspaceId,
        runId: shipped.runId,
        repoFullName: 'acme/api',
        pipelineName: 'deploy',
        commitSha: shipped.commitSha,
        linkPath: `/workspaces/${scope.workspaceId}/runs/${shipped.runId}`,
        facts: { repo: 'acme/api', pipeline: 'deploy' },
        repoId,
        projectIds: [scope.projectId],
        previousReleaseSha: null,
        gates: [{ gateId: randomUUID(), name: 'sre', resumedBy: [{ userId: actor, role: 'sre' }] }],
        resumedBy: [{ userId: actor, role: 'sre' }],
        releasedAt: now.toISOString(),
        succeededSteps: ['deploy'],
      },
    };
    const { event, subscribers } = await bus.publish(releasedEvent);
    expect(subscribers).toContain(SHIP_DETECT_SUBSCRIBER);

    await bus.deliver(event.id, SHIP_DETECT_SUBSCRIBER);
    await bus.deliver(event.id, SHIP_DETECT_SUBSCRIBER);
    // A second deploy.released for the same run (published under another key) suggests and
    // announces nothing new.
    const duplicate = await bus.publish({ ...releasedEvent, dedupeKey: `duplicate:${shipped.runId}` });
    expect(duplicate.created).toBe(true);
    await bus.deliver(duplicate.event.id, SHIP_DETECT_SUBSCRIBER);

    expect(await suggestionsOf(dark.id)).toMatchObject([{ runId: shipped.runId, gateNames: ['sre'] }]);
    expect(
      await t.db
        .select()
        .from(feedbackStatusChanges)
        .where(
          and(
            eq(feedbackStatusChanges.postId, dark.id),
            eq(feedbackStatusChanges.toStatus, FeedbackPostStatuses.shipped),
          ),
        ),
    ).toEqual([]);

    const [notice, ...others] = await notices();
    expect(others).toEqual([]);
    // The notification fan-out takes it, as `events.deliver` would hand it over.
    expect(bus.subscribersFor(FeedbackEventTypes.feedbackShipSuggested)).toEqual([
      NotificationSubscribers.feedback.name,
    ]);
    await bus.deliver(notice?.id ?? '', NotificationSubscribers.feedback.name);
    const deliveries = await t.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.workspaceId, scope.workspaceId));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ channelId: channel.id });
    expect(deliveries[0]?.message).toMatchObject({
      title: `1 post shipped on Ideas in run ${shipped.commitSha.slice(0, 7)}`,
      fields: expect.arrayContaining([{ name: 'Approved by', value: 'sre', inline: false }]),
    });
  });
});
