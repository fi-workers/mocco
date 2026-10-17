import type { FeedbackLinkKind, FeedbackLinkState } from '@mocco/common/feedback';
import type { AvailableRepoDto } from '@mocco/common/integration';

// Provider-agnostic ports (ISP: one per consumer). NO vendor imports here — the
// GitHub adapter (domain/integration/github/provider.ts) implements them and
// returns neutral @mocco/common types. Auth (token minting) lives inside the
// adapter, never on these ports.

/** Lists the repos a connection's account can access. Consumed by ConnectionService. */
export interface RepoLister {
  /** `externalAccountId` = github installation id. */
  listRepos(externalAccountId: string): Promise<AvailableRepoDto[]>;
}

export interface OwnershipResult {
  ownerVerified: boolean;
  accountLogin: string;
  githubUserId: string;
}

/** Install-handshake operations. Consumed by ConnectionService (installUrl) and the setup route (verifyOwnership). */
export interface InstallationVerifier {
  /** Exchange the setup-callback OAuth `code` for a user token and confirm the caller admins `externalAccountId`. */
  verifyOwnership(code: string, externalAccountId: string): Promise<OwnershipResult>;
  /** Build the provider install URL carrying our opaque `state`. */
  installUrl(state: string): string;
}

export interface SourceCommit {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedAt: Date;
}

/** Backfill/read-back of commit history. Consumed by the commit-sync service. */
export interface CommitSource {
  /** Recent commits on a branch (bounded backfill). `limit` capped by the caller at BACKFILL_MAX_LIMIT. */
  listCommits(
    ref: { externalAccountId: string; owner: string; name: string },
    branch: string,
    limit: number,
  ): Promise<SourceCommit[]>;
  /** Raw `.mocco.yml` at a commit SHA, or null when the repo has none at that SHA (404). */
  getConfigAtCommit(
    ref: { externalAccountId: string; owner: string; name: string },
    sha: string,
  ): Promise<string | null>;
}

/** Any file of a repo at a commit (`.mocco/flags.yml`, #145), or null when it has none there. */
export interface RepoFileSource {
  getFileAtCommit(
    ref: { externalAccountId: string; owner: string; name: string },
    sha: string,
    path: string,
  ): Promise<string | null>;
}

/** A repo's code at a commit, as a gzipped tar (#146: which flag keys a deploy contains). */
export interface RepoArchiveSource {
  getArchiveAtCommit(ref: { externalAccountId: string; owner: string; name: string }, sha: string): Promise<Uint8Array>;
}

/** How a finished check ended. Only the two that never block a merge on their own. */
export const CheckConclusions = {
  success: 'success',
  neutral: 'neutral',
} as const;
export type CheckConclusion = (typeof CheckConclusions)[keyof typeof CheckConclusions];

/** A finished check on a commit, with a Markdown report (#146: the flags plan on a PR). */
export interface CheckReport {
  name: string;
  headSha: string;
  conclusion: CheckConclusion;
  title: string;
  /** Markdown, shown first. */
  summary: string;
  /** Markdown, the details under the summary. */
  text: string;
}

/** Publishes a check on a commit (github: a completed check run). */
export interface CheckPublisher {
  publishCheck(ref: { externalAccountId: string; owner: string; name: string }, report: CheckReport): Promise<void>;
}

/** Fires an out-of-band event at a provider repo to kick off external execution
 * (github: a `repository_dispatch`). The neutral seam the GitHub executor adapter
 * (domain/execution/executors/github) triggers through — so the executor never
 * imports octokit; token minting + the vendor request stay inside the adapter.
 * `ref.externalAccountId` = github installation id; `eventType`/`clientPayload`
 * map to the provider's `event_type`/`client_payload`. Consumed by GitHubExecutor. */
export interface RepositoryDispatcher {
  dispatch(
    ref: { externalAccountId: string; owner: string; name: string },
    eventType: string,
    clientPayload: Record<string, unknown>,
  ): Promise<void>;
}

/** A provider repo an installation can read, by the installation (`externalAccountId`) and name. */
export interface TrackerRepoRef {
  externalAccountId: string;
  owner: string;
  name: string;
}

/** An issue or pull request as the provider reports it now. */
export interface TrackerItem {
  kind: FeedbackLinkKind;
  number: number;
  /** The provider's global id (github: the GraphQL node id). */
  nodeId: string;
  title: string;
  url: string;
  state: FeedbackLinkState;
  /** Pull requests only: the merge commit once merged (null otherwise, and on search results). */
  mergeCommitSha: string | null;
  mergedAt: Date | null;
}

/** A pull request that closes an issue when it merges, in the issue's own repo. */
export type TrackerPullRequest = Omit<TrackerItem, 'kind'>;

/** Reads a repo's issues and pull requests for feedback links (#178). The GitHub adapter
 * implements it under the App's `issues: read` and `pull_requests: read`. */
export interface IssueTracker {
  /** Up to `limit` issues or pull requests matching `query` (words, or a number), best match first. */
  search(repo: TrackerRepoRef, kind: FeedbackLinkKind, query: string, limit: number): Promise<TrackerItem[]>;
  /** One issue or pull request, or null when the repo has none of that kind with the number. */
  get(repo: TrackerRepoRef, kind: FeedbackLinkKind, number: number): Promise<TrackerItem | null>;
  /** The pull requests in the issue's repo that close it when merged (open, closed or merged). */
  closingPullRequests(repo: TrackerRepoRef, issueNumber: number): Promise<TrackerPullRequest[]>;
}

/** An issue or pull request in a registered repo changed (any action): what it is now. The repo
 * is resolved through the installation's connection, never by the provider's repo id alone. */
export interface TrackerEvent {
  workspaceId: string;
  repoId: string;
  ref: TrackerRepoRef;
  item: TrackerItem;
}

/** Takes issue and pull request changes from the webhook pass (feedback links' LinkService). */
export interface TrackerEventSink {
  applyProviderEvent(event: TrackerEvent): Promise<void>;
}
