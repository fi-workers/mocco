// The ship detector (#179): a release of a repo ships the board posts whose linked pull requests
// (or the pull requests closing their linked issues) it contains. A release is the platform's
// `deploy.released`: a run that succeeded and passed a resumed gate (ADR 0003, ADR 0031). A board
// names the repo whose releases count, and optionally a step the run must have succeeded.
//
// Each linked merge commit is checked against the released commit: the same SHA needs no question;
// anything else asks GitHub through the CommitAncestry port (feedback never imports octokit), with
// answers cached for the release and at most `SHIP_ANCESTRY_CALL_CAP` calls per release. A link is
// marked with the first release that contained it; a post whose links meet the board's policy gets
// one suggestion per (post, run), and the run's posts are grouped in one draft changelog entry.
// Every write is idempotent, so a repeated delivery of the same release suggests nothing new.
import { AuditActions } from '@mocco/common/audit';
import {
  FeedbackLinkKinds,
  FeedbackLinkStates,
  FeedbackPostStatuses,
  ShipModes,
  ShipPolicies,
  ShipSuggestionStates,
} from '@mocco/common/feedback';

import { AncestryChecks, SHIP_ANCESTRY_CALL_CAP } from '@backend/domain/feedback/ancestry-checks';
import { FeedbackBoardRepo } from '@backend/domain/feedback/repos/board.repo';
import { FeedbackLinkCloserRepo } from '@backend/domain/feedback/repos/link-closer.repo';
import { FeedbackLinkRepo } from '@backend/domain/feedback/repos/link.repo';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';
import { ShipSuggestionRepo } from '@backend/domain/feedback/repos/ship-suggestion.repo';
import { FeedbackTrackerRepoRepo } from '@backend/domain/feedback/repos/tracker-repo.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { ChangelogService } from '@backend/domain/feedback/ChangelogService';
import type { FeedbackBoardRow } from '@backend/domain/feedback/repos/board.repo';
import type { FeedbackLinkCloserRow } from '@backend/domain/feedback/repos/link-closer.repo';
import type { FeedbackLinkRow } from '@backend/domain/feedback/repos/link.repo';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { ShipSuggestionRow } from '@backend/domain/feedback/repos/ship-suggestion.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { ShipSuggestionService } from '@backend/domain/feedback/ShipSuggestionService';
import type { CommitAncestry } from '@backend/domain/integration/ports';
import type { Db } from '@backend/infra/db/types';
import type { ShipPolicy } from '@mocco/common/feedback';

/** What the detector needs to know about a release (from `deploy.released`). */
export interface ShippingRelease {
  workspaceId: string;
  runId: string;
  repoId: string;
  /** The projects the release was recorded for (those linked to its repo). */
  projectIds: readonly string[];
  commitSha: string;
  /** The resumed gates the run passed, by name ("approved by"). */
  gateNames: readonly string[];
  /** The run's steps that succeeded, by name. */
  succeededSteps: readonly string[];
}

/** The merge commits a link ships with: a merged pull request's, or those of an issue's merged closers. */
function mergeShasOf(link: FeedbackLinkRow, closers: readonly FeedbackLinkCloserRow[]): string[] {
  if (link.kind === FeedbackLinkKinds.pullRequest) {
    return link.state === FeedbackLinkStates.merged && link.mergeCommitSha !== null ? [link.mergeCommitSha] : [];
  }
  return closers.flatMap(closer =>
    closer.linkId === link.id && closer.state === FeedbackLinkStates.merged && closer.mergeCommitSha !== null
      ? [closer.mergeCommitSha]
      : [],
  );
}

/**
 * Does the post count as shipped under the policy? Shipped links always count. Of the rest, an
 * abandoned link doesn't: a pull request closed without merging, or an issue closed with no merged
 * pull request (closed as not planned). `all_links_shipped` needs every link that counts shipped;
 * `any_link_shipped` needs one.
 */
export function isShippedUnderPolicy(
  policy: ShipPolicy,
  links: readonly FeedbackLinkRow[],
  closers: readonly FeedbackLinkCloserRow[],
): boolean {
  const isShipped = (link: FeedbackLinkRow) => link.shippedRunId !== null;
  if (policy === ShipPolicies.anyLinkShipped) {
    return links.some(link => isShipped(link));
  }
  const counting = links.filter(
    link => isShipped(link) || link.state === FeedbackLinkStates.open || mergeShasOf(link, closers).length > 0,
  );
  return counting.length > 0 && counting.every(link => isShipped(link));
}

/** Pre-filled words for the run's draft entry: the posts' titles, each with its pull requests. */
export function shipDraftOf(
  posts: readonly Pick<FeedbackPostRow, 'id' | 'title'>[],
  links: readonly FeedbackLinkRow[],
  closers: readonly FeedbackLinkCloserRow[],
): { title: string; body: string } {
  const [first] = posts;
  const title =
    first === undefined || posts.length === 1
      ? (first?.title ?? 'Shipped')
      : `${first.title} and ${String(posts.length - 1)} more`;
  const lines = posts.map(post => {
    const shipped = links.filter(link => link.postId === post.id && link.shippedRunId !== null);
    const pulls = shipped.flatMap(link =>
      link.kind === FeedbackLinkKinds.pullRequest
        ? [{ number: link.externalNumber, url: link.url }]
        : closers
            .filter(closer => closer.linkId === link.id && closer.state === FeedbackLinkStates.merged)
            .map(closer => ({ number: closer.prNumber, url: closer.url })),
    );
    const refs = pulls.map(pull => `[#${String(pull.number)}](${pull.url})`).join(', ');
    return refs === '' ? `- ${post.title}` : `- ${post.title} (${refs})`;
  });
  return { title, body: lines.join('\n') };
}

export interface ShipDetectorDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  changelog: Pick<ChangelogService, 'draftForRun'>;
  suggestions: Pick<ShipSuggestionService, 'autoApply'>;
  /** Answers whether a release contains a merge commit; without one, only the same SHA counts. */
  ancestry?: CommitAncestry;
  /** Ancestry calls per release; `SHIP_ANCESTRY_CALL_CAP` by default. */
  ancestryCallCap?: number;
  now?: () => Date;
}

export class ShipDetector {
  constructor(private readonly deps: ShipDetectorDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async detectOnBoard(
    board: FeedbackBoardRow,
    release: ShippingRelease,
    checks: AncestryChecks,
  ): Promise<ShipSuggestionRow[]> {
    const { db } = this.deps;
    const scope: FeedbackScope = { workspaceId: board.workspaceId, projectId: board.projectId };
    const links = new FeedbackLinkRepo(db);
    const closerRepo = new FeedbackLinkCloserRepo(db);

    const candidates = await links.unshippedOnBoard(scope.workspaceId, board.id, release.repoId);
    const candidateClosers = await closerRepo.ofLinks(
      scope.workspaceId,
      candidates.filter(link => link.kind === FeedbackLinkKinds.issue).map(link => link.id),
    );
    // One question at a time, so the cap and the cache hold.
    const contained = await candidates.reduce<Promise<string[]>>(async (previous, link) => {
      const found = await previous;
      const isContained = await mergeShasOf(link, candidateClosers).reduce<Promise<boolean>>(
        async (earlier, sha) => (await earlier) || (await checks.contains(sha, release.commitSha)) === true,
        Promise.resolve(false),
      );
      return isContained ? [...found, link.id] : found;
    }, Promise.resolve([]));
    await links.markShipped(scope.workspaceId, contained, release.runId, this.now());

    // Every post this run shipped a link of, also on a repeated delivery (the marks stay).
    const shippedPostIds = await links.postIdsShippedBy(scope.workspaceId, board.id, release.runId);
    const suggestions = new ShipSuggestionRepo(db);
    const ofRun = await suggestions.ofRun(scope.workspaceId, board.id, release.runId);
    const alreadyThisRun = new Set(ofRun.map(row => row.postId));
    const waitingElsewhere = await suggestions.postsWithPending(scope.workspaceId, shippedPostIds);
    const posts = await new FeedbackPostRepo(db).findMany(scope, shippedPostIds);
    const postLinks = await links.ofPosts(scope.workspaceId, shippedPostIds);
    const postClosers = await closerRepo.ofLinks(
      scope.workspaceId,
      postLinks.filter(link => link.kind === FeedbackLinkKinds.issue).map(link => link.id),
    );
    const eligible = posts.filter(
      post =>
        post.mergedIntoPostId === null &&
        post.status !== FeedbackPostStatuses.shipped &&
        (alreadyThisRun.has(post.id) || !waitingElsewhere.has(post.id)) &&
        isShippedUnderPolicy(
          board.shipPolicy,
          postLinks.filter(link => link.postId === post.id),
          postClosers,
        ),
    );
    const inserted = await suggestions.insertMissing(
      eligible.map(post => ({
        ...scope,
        boardId: board.id,
        postId: post.id,
        runId: release.runId,
        commitSha: release.commitSha,
        gateNames: [...release.gateNames],
      })),
    );

    const entryId = await this.draft(scope, board, release.runId, { posts, postLinks, postClosers });
    await inserted.reduce(async (previous, suggestion) => {
      await previous;
      const post = posts.find(row => row.id === suggestion.postId);
      await this.deps.audit.record(scope.workspaceId, {
        actorUserId: null,
        action: AuditActions.feedbackShippedSuggested,
        subjectType: 'feedback_post',
        subjectId: suggestion.postId,
        payload: {
          projectId: scope.projectId,
          boardId: board.id,
          number: post?.number ?? null,
          runId: release.runId,
          commitSha: release.commitSha,
          gates: release.gateNames,
          suggestionId: suggestion.id,
          changelogEntryId: entryId ?? null,
        },
      });
    }, Promise.resolve());

    if (board.shipMode === ShipModes.autoApply) {
      await this.deps.suggestions.autoApply(scope, board.id, release.runId);
    }
    return inserted;
  }

  /**
   * Make sure the run's waiting suggestions on the board point at its draft entry, which groups
   * every post the run suggested there. Repeats create nothing new. Returns the entry's id, or
   * undefined when the run suggested nothing waiting on the board.
   */
  private async draft(
    scope: FeedbackScope,
    board: FeedbackBoardRow,
    runId: string,
    known: {
      posts: readonly FeedbackPostRow[];
      postLinks: readonly FeedbackLinkRow[];
      postClosers: readonly FeedbackLinkCloserRow[];
    },
  ): Promise<string | undefined> {
    const suggestions = new ShipSuggestionRepo(this.deps.db);
    const ofRun = await suggestions.ofRun(scope.workspaceId, board.id, runId);
    const waiting = ofRun.filter(row => row.state === ShipSuggestionStates.pending && row.changelogEntryId === null);
    if (waiting.length === 0) {
      return ofRun.find(row => row.changelogEntryId !== null)?.changelogEntryId ?? undefined;
    }
    // By number: `known.posts` comes in that order.
    const posts = known.posts.filter(post => ofRun.some(row => row.postId === post.id));
    const entry = await this.deps.changelog.draftForRun(scope, board.id, runId, {
      ...shipDraftOf(posts, known.postLinks, known.postClosers),
      postIds: posts.map(post => post.id),
    });
    await suggestions.setChangelogEntry(
      scope.workspaceId,
      waiting.map(row => row.id),
      entry.id,
    );
    return entry.id;
  }

  /**
   * Handle one release: on every board it ships, mark the links it contains and suggest the posts
   * that are now shipped. Returns the suggestions this call created (none on a repeat).
   */
  async detect(release: ShippingRelease): Promise<ShipSuggestionRow[]> {
    const released = await new FeedbackBoardRepo(this.deps.db).releasedBy(release.workspaceId, release.repoId);
    const boards = released.filter(
      board =>
        release.projectIds.includes(board.projectId) &&
        (board.releaseStepName === null || release.succeededSteps.includes(board.releaseStepName)),
    );
    if (boards.length === 0) {
      return [];
    }
    const repo = await new FeedbackTrackerRepoRepo(this.deps.db).findInWorkspace(release.workspaceId, release.repoId);
    const checks = new AncestryChecks(
      this.deps.ancestry,
      repo === undefined
        ? undefined
        : { externalAccountId: repo.externalAccountId, owner: repo.owner, name: repo.name },
      this.deps.ancestryCallCap ?? SHIP_ANCESTRY_CALL_CAP,
    );
    // One board at a time: production's pool is a single connection, and the checks share a budget.
    return await boards.reduce<Promise<ShipSuggestionRow[]>>(async (previous, board) => {
      const done = await previous;
      return [...done, ...(await this.detectOnBoard(board, release, checks))];
    }, Promise.resolve([]));
  }
}
