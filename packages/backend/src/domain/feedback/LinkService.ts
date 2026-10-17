// GitHub issues and pull requests linked to posts (#178). Staff search the repos linked to the
// post's project and link an issue or pull request by number; the link keeps its title, state and,
// once merged, the merge commit. `issues` and `pull_request` webhooks reach `applyProviderEvent`
// from the deferred webhook pass and keep links current; the `feedback.links.refresh` job reads
// links nobody has heard about for a while, for deliveries that never arrived. An issue link also
// keeps the pull requests that close it (its closers), resolved when it is linked, when its state
// changes and on refresh, and updated by their own `pull_request` events.
//
// Feedback reads issues and pull requests only through the IssueTracker port; the GitHub adapter
// (domain/integration/github/provider.ts) implements it.
import { AuditActions } from '@mocco/common/audit';
import { FeedbackLinkKinds } from '@mocco/common/feedback';

import {
  FeedbackIssueTrackerUnavailableError,
  FeedbackLinkExistsError,
  FeedbackLinkNotFoundError,
  FeedbackLinkRepoNotFoundError,
  FeedbackLinkTargetNotFoundError,
  FeedbackPostMergedError,
} from '@backend/domain/feedback/errors';
import { FeedbackLinkCloserRepo } from '@backend/domain/feedback/repos/link-closer.repo';
import { FeedbackLinkRepo } from '@backend/domain/feedback/repos/link.repo';
import { FeedbackTrackerRepoRepo } from '@backend/domain/feedback/repos/tracker-repo.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { PostService } from '@backend/domain/feedback/PostService';
import type { FeedbackLinkCloserFields, FeedbackLinkCloserRow } from '@backend/domain/feedback/repos/link-closer.repo';
import type { FeedbackLinkLiveFields, FeedbackLinkRow } from '@backend/domain/feedback/repos/link.repo';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { FeedbackTrackerRepoRow } from '@backend/domain/feedback/repos/tracker-repo.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type {
  IssueTracker,
  TrackerEvent,
  TrackerEventSink,
  TrackerItem,
  TrackerPullRequest,
  TrackerRepoRef,
} from '@backend/domain/integration/ports';
import type { Db } from '@backend/infra/db/types';
import type { FeedbackLinkCreateInput, FeedbackLinkKind } from '@mocco/common/feedback';

export const LinkRefreshPolicy = {
  /** A link not heard about for this long is read again by the refresh job. */
  staleAfterMs: 6 * 60 * 60 * 1000,
  /** Links one run reads (each one or two provider calls). */
  linksPerRun: 20,
} as const;

/** A link as the post page shows it: the repo by name, and an issue's closing pull requests. */
export interface FeedbackLinkView extends FeedbackLinkRow {
  repo: { owner: string; name: string } | null;
  closers: FeedbackLinkCloserRow[];
}

export interface LinkServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  posts: Pick<PostService, 'requirePost'>;
  /** Undefined on a server without a GitHub App: links can't be made, but existing ones still list. */
  tracker?: IssueTracker;
  now?: () => Date;
}

const liveFields = (item: TrackerItem | TrackerPullRequest): FeedbackLinkLiveFields => ({
  externalNodeId: item.nodeId,
  title: item.title,
  url: item.url,
  state: item.state,
  mergeCommitSha: item.mergeCommitSha,
  mergedAt: item.mergedAt,
});

const closerFields = (pull: TrackerPullRequest): FeedbackLinkCloserFields => ({
  prNumber: pull.number,
  ...liveFields(pull),
});

const refOf = (repo: FeedbackTrackerRepoRow): TrackerRepoRef => ({
  externalAccountId: repo.externalAccountId,
  owner: repo.owner,
  name: repo.name,
});

export class LinkService implements TrackerEventSink {
  constructor(private readonly deps: LinkServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private requireTracker(): IssueTracker {
    if (this.deps.tracker === undefined) {
      throw new FeedbackIssueTrackerUnavailableError();
    }
    return this.deps.tracker;
  }

  /** A repo linked to the project, or FeedbackLinkRepoNotFoundError (also for another workspace's). */
  private async requireRepo(scope: FeedbackScope, repoId: string): Promise<FeedbackTrackerRepoRow> {
    const repo = await new FeedbackTrackerRepoRepo(this.deps.db).findInProject(scope, repoId);
    if (repo === undefined) {
      throw new FeedbackLinkRepoNotFoundError(repoId);
    }
    return repo;
  }

  /** Resolve an issue link's closing pull requests again. Best-effort: the link stands without. */
  private async resolveClosers(link: FeedbackLinkRow, ref: TrackerRepoRef): Promise<void> {
    if (link.kind !== FeedbackLinkKinds.issue || this.deps.tracker === undefined) {
      return;
    }
    try {
      const pulls = await this.deps.tracker.closingPullRequests(ref, link.externalNumber);
      await new FeedbackLinkCloserRepo(this.deps.db).replace(
        link,
        pulls.map(pullRequest => closerFields(pullRequest)),
        this.now(),
      );
    } catch (error) {
      console.error(`[feedback-links] closing pull requests of link ${link.id} could not be read`, error);
    }
  }

  /** The post (not a merged one), the project's repo and the issue or pull request as the provider
   * has it now: what `link` would link, read with the same refusals and nothing written. */
  private async resolveTarget(scope: FeedbackScope, postId: string, input: FeedbackLinkCreateInput) {
    const post = await this.deps.posts.requirePost(scope, postId);
    if (post.mergedIntoPostId !== null) {
      throw new FeedbackPostMergedError(post.id, post.mergedIntoPostId);
    }
    const repo = await this.requireRepo(scope, input.repoId);
    const item = await this.requireTracker().get(refOf(repo), input.kind, input.number);
    if (item === null) {
      throw new FeedbackLinkTargetNotFoundError(input.kind, input.number);
    }
    return { post, repo, item };
  }

  /** The repos the project links, which a post's links come from. */
  async repos(scope: FeedbackScope): Promise<{ id: string; owner: string; name: string }[]> {
    const rows = await new FeedbackTrackerRepoRepo(this.deps.db).ofProject(scope);
    return rows.map(row => ({ id: row.id, owner: row.owner, name: row.name }));
  }

  /** Issues or pull requests of a project's repo matching `query` (words, or a number). */
  async search(
    scope: FeedbackScope,
    input: { repoId: string; kind: FeedbackLinkKind; query: string },
    limit: number,
  ): Promise<TrackerItem[]> {
    const repo = await this.requireRepo(scope, input.repoId);
    return await this.requireTracker().search(refOf(repo), input.kind, input.query, limit);
  }

  /** A post's links, oldest first, with their repos and closing pull requests. */
  async list(scope: FeedbackScope, postId: string): Promise<FeedbackLinkView[]> {
    await this.deps.posts.requirePost(scope, postId);
    const links = await new FeedbackLinkRepo(this.deps.db).ofPost(scope, postId);
    const closers = await new FeedbackLinkCloserRepo(this.deps.db).ofLinks(
      scope.workspaceId,
      links.map(link => link.id),
    );
    const projectRepos = await new FeedbackTrackerRepoRepo(this.deps.db).ofProject(scope);
    const repos = new Map(projectRepos.map(row => [row.id, row]));
    return links.map(link => {
      const repo = repos.get(link.repoId);
      return {
        ...link,
        repo: repo === undefined ? null : { owner: repo.owner, name: repo.name },
        closers: closers.filter(closer => closer.linkId === link.id),
      };
    });
  }

  /**
   * What linking would link, before anyone is asked to confirm it (the MCP tool): the post, the
   * repo by name, and the issue or pull request as the provider has it now. Refuses exactly as
   * `link` does, and also when the post links it already (FeedbackLinkExistsError). Writes nothing.
   */
  async preview(
    scope: FeedbackScope,
    postId: string,
    input: FeedbackLinkCreateInput,
  ): Promise<{ post: FeedbackPostRow; repo: { id: string; owner: string; name: string }; item: TrackerItem }> {
    const { post, repo, item } = await this.resolveTarget(scope, postId, input);
    const existing = await new FeedbackLinkRepo(this.deps.db).findByTarget(
      scope.workspaceId,
      repo.id,
      item.kind,
      item.number,
    );
    if (existing.some(link => link.postId === post.id)) {
      throw new FeedbackLinkExistsError();
    }
    return { post, repo: { id: repo.id, owner: repo.owner, name: repo.name }, item };
  }

  /** One of the project's links with its repo by name, or FeedbackLinkNotFoundError (also another project's). */
  async requireLink(
    scope: FeedbackScope,
    linkId: string,
  ): Promise<FeedbackLinkRow & { repo: { owner: string; name: string } | null }> {
    const link = await new FeedbackLinkRepo(this.deps.db).find(scope, linkId);
    if (link === undefined) {
      throw new FeedbackLinkNotFoundError(linkId);
    }
    const repo = await new FeedbackTrackerRepoRepo(this.deps.db).findInWorkspace(scope.workspaceId, link.repoId);
    return { ...link, repo: repo === undefined ? null : { owner: repo.owner, name: repo.name } };
  }

  /**
   * Link an issue or pull request of one of the project's repos to the post, as the provider has it
   * now; an issue's closing pull requests come with it. A repo the project doesn't link is
   * FeedbackLinkRepoNotFoundError, a number the repo doesn't have FeedbackLinkTargetNotFoundError,
   * the same link again FeedbackLinkExistsError, and a merged post FeedbackPostMergedError.
   */
  async link(
    scope: FeedbackScope,
    actorUserId: string,
    postId: string,
    input: FeedbackLinkCreateInput,
  ): Promise<FeedbackLinkRow> {
    const { post, repo, item } = await this.resolveTarget(scope, postId, input);
    const ref = refOf(repo);
    const link = await new FeedbackLinkRepo(this.deps.db).insert({
      ...scope,
      postId,
      repoId: repo.id,
      kind: item.kind,
      externalNumber: item.number,
      ...liveFields(item),
      createdByUserId: actorUserId,
      refreshedAt: this.now(),
    });
    if (link === undefined) {
      throw new FeedbackLinkExistsError();
    }
    await this.resolveClosers(link, ref);
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.feedbackPostLinked,
      subjectType: 'feedback_post',
      subjectId: post.id,
      payload: {
        projectId: scope.projectId,
        boardId: post.boardId,
        number: post.number,
        repo: `${repo.owner}/${repo.name}`,
        kind: link.kind,
        externalNumber: link.externalNumber,
      },
    });
    return link;
  }

  /** Remove a link (and its closers); another project's is FeedbackLinkNotFoundError. */
  async unlink(scope: FeedbackScope, actorUserId: string, linkId: string): Promise<void> {
    const link = await new FeedbackLinkRepo(this.deps.db).delete(scope, linkId);
    if (link === undefined) {
      throw new FeedbackLinkNotFoundError(linkId);
    }
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.feedbackPostUnlinked,
      subjectType: 'feedback_post',
      subjectId: link.postId,
      payload: { projectId: scope.projectId, kind: link.kind, externalNumber: link.externalNumber, url: link.url },
    });
  }

  /**
   * An issue or pull request changed (the deferred webhook pass): every link to it, and for a pull
   * request every closer row for it, takes its state now. An issue whose state moved has its closing
   * pull requests resolved again. Nothing linked is parked: logged, never thrown.
   */
  async applyProviderEvent(event: TrackerEvent): Promise<void> {
    const { item } = event;
    const now = this.now();
    const links = new FeedbackLinkRepo(this.deps.db);
    const targets = await links.findByTarget(event.workspaceId, event.repoId, item.kind, item.number);
    const closerRows =
      item.kind === FeedbackLinkKinds.pullRequest
        ? await new FeedbackLinkCloserRepo(this.deps.db).refreshPullRequest(
            event.workspaceId,
            event.repoId,
            closerFields(item),
            now,
          )
        : 0;
    if (targets.length === 0 && closerRows === 0) {
      console.warn(
        `[feedback-links] ${item.kind} #${String(item.number)} of repo ${event.repoId} is not linked — parked`,
      );
      return;
    }
    await targets.reduce(async (previous, link) => {
      await previous;
      await links.refresh(event.workspaceId, link.id, liveFields(item), now);
      if (link.state !== item.state) {
        await this.resolveClosers(link, event.ref);
      }
    }, Promise.resolve());
  }

  /**
   * Read again the links not heard about for `LinkRefreshPolicy.staleAfterMs` (a missed webhook),
   * the longest ago first. A link whose repo or target is gone keeps its last state, and a provider
   * failure is logged; either way it waits its next turn. How many links were read.
   */
  async refreshStale(): Promise<number> {
    const { tracker } = this.deps;
    if (tracker === undefined) {
      return 0;
    }
    const now = this.now();
    const links = new FeedbackLinkRepo(this.deps.db);
    const repos = new FeedbackTrackerRepoRepo(this.deps.db);
    const due = await links.staleBefore(
      new Date(now.getTime() - LinkRefreshPolicy.staleAfterMs),
      LinkRefreshPolicy.linksPerRun,
    );
    await due.reduce(async (previous, link) => {
      await previous;
      // Its turn is taken first, so a link that keeps failing can't hold up the others.
      await links.touch(link.workspaceId, link.id, now);
      try {
        const repo = await repos.findInWorkspace(link.workspaceId, link.repoId);
        const item = repo === undefined ? null : await tracker.get(refOf(repo), link.kind, link.externalNumber);
        if (repo === undefined || item === null) {
          return; // Gone (repo removed, issue deleted): keep what we knew.
        }
        await links.refresh(link.workspaceId, link.id, liveFields(item), now);
        await this.resolveClosers(link, refOf(repo));
      } catch (error) {
        console.error(`[feedback-links] refreshing link ${link.id} failed`, error);
      }
    }, Promise.resolve());
    return due.length;
  }
}
