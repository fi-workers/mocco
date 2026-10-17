import { createHmac, timingSafeEqual } from 'node:crypto';

import { FeedbackLinkKinds, FeedbackLinkStates } from '@mocco/common/feedback';
import { App } from '@octokit/app';
import { z } from 'zod';

import { BACKFILL_MAX_LIMIT } from '@backend/domain/integration/constants';
import {
  CONFIG_FILE_PATH,
  GithubGraphqlPullRequestStates,
  GithubCompareStatuses,
  GithubIssueStates,
  GithubWebhookEvents,
  SIGNATURE_ALGORITHM,
  WebhookKinds,
} from '@backend/domain/integration/github/constants';
import {
  GithubApiError,
  octokitStatus,
  ProviderConnectionRevokedError,
  WebhookParseError,
} from '@backend/domain/integration/github/errors';
import {
  installationEventSchema,
  installationRepositoriesEventSchema,
  issuesEventSchema,
  pullRequestEventSchema,
  pushEventSchema,
} from '@backend/domain/integration/github/webhook-events';

import type { ParsedWebhook } from '@backend/domain/integration/github/webhook-events';
import type {
  CheckPublisher,
  CheckReport,
  CommitAncestry,
  CommitSource,
  InstallationVerifier,
  IssueTracker,
  OwnershipResult,
  RepoArchiveSource,
  RepoFileSource,
  RepoLister,
  RepositoryDispatcher,
  SourceCommit,
  TrackerItem,
  TrackerPullRequest,
  TrackerRepoRef,
} from '@backend/domain/integration/ports';
import type { FeedbackLinkKind } from '@mocco/common/feedback';
import type { AvailableRepoDto } from '@mocco/common/integration';

// The ONLY file importing the GitHub SDK (@octokit/app). Everything above the
// port returns neutral @mocco/common types; the octokit error object never
// escapes this file (it can carry the installation token in request headers).
// Throttling/retry plugins are wired in slice 3b where commit/config fan-out
// makes secondary-rate-limit handling matter; 3a issues single reads.

export interface GitHubConfig {
  appId: string;
  slug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
}

/** Raw shape of a GitHub repository we depend on. Narrower than octokit's type; mapped to neutral. */
interface RawRepo {
  id: number;
  name: string;
  default_branch: string;
  owner: { login: string };
}

/** Pure mapper: GitHub repo -> neutral AvailableRepoDto. Unit-tested. */
export function toRepo(raw: RawRepo): AvailableRepoDto {
  return { externalRepoId: String(raw.id), owner: raw.owner.login, name: raw.name, defaultBranch: raw.default_branch };
}

/** Raw shape of a `push` webhook commit entry (`webhook-events.ts#pushEventSchema`). */
interface RawPushCommit {
  id: string;
  message: string;
  timestamp: string;
  author: { name: string; email: string };
}

/** Pure mapper: push-webhook commit -> neutral SourceCommit. Unit-tested. */
export function toSourceCommit(raw: RawPushCommit): SourceCommit {
  return {
    sha: raw.id,
    message: raw.message,
    authorName: raw.author.name,
    authorEmail: raw.author.email,
    committedAt: new Date(raw.timestamp),
  };
}

/** Raw shape of a REST `GET /repos/{owner}/{repo}/commits` list item. Nests
 * differently from the push-webhook shape above (`sha` not `id`, message/author
 * under `commit`) — GitHub's git-commit `author` is nullable/partial when the
 * underlying git commit has no attributable author. */
interface RawListedCommit {
  sha: string;
  commit: { message: string; author: { name?: string; email?: string; date?: string } | null };
}

/** Pure mapper: REST-listed commit -> neutral SourceCommit. Unit-tested (listCommits
 * itself stays a thin network wrapper — no branching logic left untested there). */
export function toListedCommit(raw: RawListedCommit): SourceCommit {
  const { author } = raw.commit;
  return {
    sha: raw.sha,
    message: raw.commit.message,
    authorName: author?.name ?? '',
    authorEmail: author?.email ?? '',
    committedAt: author?.date === undefined ? new Date(0) : new Date(author.date),
  };
}

/** The single base64-encoded file variant of a GitHub "get content" response —
 * narrower than octokit's full union of file/directory/symlink/submodule. Only the
 * file variant carries a base64 `content` string; a symlink/submodule has no
 * `content`, and a directory listing is an array (rejected before parse). `content`
 * is validated as a string so a non-string shape can't slip through to `Buffer`. */
const base64ContentFileSchema = z.object({ content: z.string(), encoding: z.literal('base64') });

/** Pure mapper: GitHub "get content" response -> decoded UTF-8 text. Unit-tested.
 * Rejects anything that isn't a single base64-encoded file — a directory (array),
 * or an object failing `base64ContentFileSchema` (symlink, submodule, an oversized
 * file GitHub declined to inline, or a non-string `content`) — with a mapped
 * `GithubApiError` instead of crashing on an unexpected shape. `getConfigAtCommit`
 * stays a thin wrapper: this is where the only branching logic lives, and it's
 * fully covered here without any network call. */
export function decodeGetContent(data: unknown): string {
  if (Array.isArray(data)) {
    throw new GithubApiError('expected a single file at the config path, got a directory listing', undefined);
  }
  const file = base64ContentFileSchema.safeParse(data);
  if (!file.success) {
    throw new GithubApiError('expected a base64-encoded file at the config path', undefined);
  }
  // Uint8Array.fromBase64 is still V8-experimental (see env.ts's GITHUB_APP_PRIVATE_KEY_B64
  // transform) — Buffer is the only base64 decoder actually available on this runtime.
  // eslint-disable-next-line unicorn/prefer-uint8array-base64
  return Buffer.from(file.data.content, 'base64').toString('utf8');
}

/** GitHub refuses a check run whose output `summary` or `text` exceeds this many characters. */
export const CHECK_OUTPUT_MAX_CHARS = 65_535;

const TRUNCATED_NOTE = '\n\n_…cut short: GitHub limits how long a check report can be._';

/** Fit Markdown into a check run's output field, saying so when it's cut. Pure; unit-tested. */
export function fitCheckOutput(markdown: string): string {
  // sonarjs/null-dereference is a false positive: `markdown` is a non-optional string.
  // eslint-disable-next-line sonarjs/null-dereference
  return markdown.length <= CHECK_OUTPUT_MAX_CHARS
    ? markdown
    : `${markdown.slice(0, CHECK_OUTPUT_MAX_CHARS - TRUNCATED_NOTE.length)}${TRUNCATED_NOTE}`;
}

/** Pure mapper: a neutral CheckReport -> the `POST /repos/{owner}/{repo}/check-runs` body. Unit-tested. */
export function toCheckRunBody(report: CheckReport) {
  return {
    name: report.name,
    head_sha: report.headSha,
    status: 'completed' as const,
    conclusion: report.conclusion,
    output: { title: report.title, summary: fitCheckOutput(report.summary), text: fitCheckOutput(report.text) },
  };
}

/** Constant-time comparison of a `sha256=<hex>` webhook signature against one
 * computed from `rawBody` + `secret`. Pure (node:crypto is a Node built-in, not
 * a vendor SDK). A `null` or malformed signature returns `false`, never throws —
 * `timingSafeEqual` requires equal-length buffers, so a length mismatch is
 * checked first.
 * `verify` (not `isVerified`) is the name mandated by the port/task contract —
 * matches the webhook-route call site. */
// eslint-disable-next-line unicorn/consistent-boolean-name
export function verify(rawBody: string, signature: string | null, secret: string): boolean {
  if (signature === null) {
    return false;
  }
  const expected = `${SIGNATURE_ALGORITHM}=${createHmac(SIGNATURE_ALGORITHM, secret).update(rawBody).digest('hex')}`;
  const provided = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

/** Parse a raw webhook body against the GitHub-namespaced zod schema selected by
 * `eventType`. Pure. A schema/JSON failure is wrapped as `WebhookParseError` —
 * the zod issue list (and any payload fragment it can echo back) never leaves
 * this function. An event type we don't act on maps to `{ kind: WebhookKinds.ignored }`
 * without needing the body to parse at all.
 * sonarjs/function-return-type is a false positive here: the return type is
 * the ParsedWebhook discriminated union declared above; each branch legitimately
 * returns a different member of that single union. */
// eslint-disable-next-line sonarjs/function-return-type
export function parseWebhook(eventType: string | null, rawBody: string): ParsedWebhook {
  if (
    eventType !== GithubWebhookEvents.push &&
    eventType !== GithubWebhookEvents.installation &&
    eventType !== GithubWebhookEvents.installation_repositories &&
    eventType !== GithubWebhookEvents.pull_request &&
    eventType !== GithubWebhookEvents.issues
  ) {
    return { kind: WebhookKinds.ignored, eventType: eventType ?? 'unknown' };
  }
  try {
    const json: unknown = JSON.parse(rawBody);
    if (eventType === GithubWebhookEvents.push) {
      return { kind: WebhookKinds.push, data: pushEventSchema.parse(json) };
    }
    if (eventType === GithubWebhookEvents.installation) {
      return { kind: WebhookKinds.installation, data: installationEventSchema.parse(json) };
    }
    if (eventType === GithubWebhookEvents.pull_request) {
      return { kind: WebhookKinds.pull_request, data: pullRequestEventSchema.parse(json) };
    }
    if (eventType === GithubWebhookEvents.issues) {
      return { kind: WebhookKinds.issues, data: issuesEventSchema.parse(json) };
    }
    return { kind: WebhookKinds.installation_repositories, data: installationRepositoriesEventSchema.parse(json) };
  } catch (error) {
    throw new WebhookParseError(eventType, { cause: error });
  }
}

// ─── Issue tracker (#178: feedback links) ────────────────────────────────────

const issueStateSchema = z.enum([GithubIssueStates.open, GithubIssueStates.closed]);

/** `GET /repos/{owner}/{repo}/issues/{number}`: a pull request answers here too, with `pull_request`. */
const rawIssueSchema = z.object({
  number: z.number(),
  node_id: z.string(),
  title: z.string(),
  html_url: z.string(),
  state: issueStateSchema,
  pull_request: z.unknown().optional(),
});

/** `GET /repos/{owner}/{repo}/pulls/{number}`. `merge_commit_sha` is set on an open pull request
 * too (GitHub's test merge), so it counts only once `merged`. */
const rawPullSchema = z.object({
  number: z.number(),
  node_id: z.string(),
  title: z.string(),
  html_url: z.string(),
  state: issueStateSchema,
  merged: z.boolean().nullish(),
  merge_commit_sha: z.string().nullish(),
  merged_at: z.string().nullish(),
});

/** One `GET /search/issues` item: an issue, or a pull request with `pull_request.merged_at`. */
const rawSearchItemSchema = z.object({
  number: z.number(),
  node_id: z.string(),
  title: z.string(),
  html_url: z.string(),
  state: issueStateSchema,
  repository_url: z.string(),
  pull_request: z.object({ merged_at: z.string().nullish() }).optional(),
});
const rawSearchSchema = z.object({ items: z.array(z.unknown()) });

const closingPullsSchema = z.object({
  repository: z
    .object({
      issue: z
        .object({
          closedByPullRequestsReferences: z.object({
            nodes: z.array(
              z.object({
                id: z.string(),
                number: z.number(),
                title: z.string(),
                url: z.string(),
                state: z.enum(Object.values(GithubGraphqlPullRequestStates)),
                mergedAt: z.string().nullish(),
                mergeCommit: z.object({ oid: z.string() }).nullish(),
                repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
              }),
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

/** The pull requests that close an issue, newest references first by GitHub's order. */
export const CLOSING_PULL_REQUESTS_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 25, includeClosedPrs: true) {
        nodes { id number title url state mergedAt mergeCommit { oid } repository { name owner { login } } }
      }
    }
  }
}`;

const safeDate = (value: string | null | undefined): Date | null => (value == null ? null : new Date(value));

/** Pure mapper: REST issue -> TrackerItem, or null when it is a pull request. Unit-tested.
 * sonarjs/function-return-type is a false positive: the declared `TrackerItem | null` is the contract. */
// eslint-disable-next-line sonarjs/function-return-type
export function toTrackerIssue(data: unknown): TrackerItem | null {
  const raw = rawIssueSchema.parse(data);
  if (raw.pull_request !== undefined) {
    return null;
  }
  return {
    kind: FeedbackLinkKinds.issue,
    number: raw.number,
    nodeId: raw.node_id,
    title: raw.title,
    url: raw.html_url,
    state: raw.state === GithubIssueStates.open ? FeedbackLinkStates.open : FeedbackLinkStates.closed,
    mergeCommitSha: null,
    mergedAt: null,
  };
}

/** Pure mapper: REST pull request (or a `pull_request` webhook's) -> TrackerItem. Unit-tested. */
export function toTrackerPull(data: unknown): TrackerItem {
  const raw = rawPullSchema.parse(data);
  const isMerged = raw.merged === true || (raw.state === GithubIssueStates.closed && raw.merged_at != null);
  let state: TrackerItem['state'] = FeedbackLinkStates.closed;
  if (isMerged) {
    state = FeedbackLinkStates.merged;
  } else if (raw.state === GithubIssueStates.open) {
    state = FeedbackLinkStates.open;
  }
  return {
    kind: FeedbackLinkKinds.pullRequest,
    number: raw.number,
    nodeId: raw.node_id,
    title: raw.title,
    url: raw.html_url,
    state,
    mergeCommitSha: isMerged ? (raw.merge_commit_sha ?? null) : null,
    mergedAt: isMerged ? safeDate(raw.merged_at) : null,
  };
}

/** Pure mapper: `GET /search/issues` -> the items of `kind` in `repo` (anything else is dropped,
 * so a query can't reach another repo of the installation). Unit-tested. */
export function toTrackerSearchItems(data: unknown, repo: TrackerRepoRef, kind: FeedbackLinkKind): TrackerItem[] {
  const repoUrlSuffix = `/repos/${repo.owner}/${repo.name}`.toLowerCase();
  return rawSearchSchema.parse(data).items.flatMap(item => {
    const parsed = rawSearchItemSchema.safeParse(item);
    if (!parsed.success || !parsed.data.repository_url.toLowerCase().endsWith(repoUrlSuffix)) {
      return [];
    }
    const raw = parsed.data;
    const isPull = raw.pull_request !== undefined;
    if (isPull !== (kind === FeedbackLinkKinds.pullRequest)) {
      return [];
    }
    const mergedAt = safeDate(raw.pull_request?.merged_at);
    let state: TrackerItem['state'] = FeedbackLinkStates.closed;
    if (mergedAt !== null) {
      state = FeedbackLinkStates.merged;
    } else if (raw.state === GithubIssueStates.open) {
      state = FeedbackLinkStates.open;
    }
    return [
      {
        kind,
        number: raw.number,
        nodeId: raw.node_id,
        title: raw.title,
        url: raw.html_url,
        state,
        mergeCommitSha: null,
        mergedAt,
      },
    ];
  });
}

/** Pure mapper: the closing-pull-requests GraphQL answer -> those in the issue's own repo. Unit-tested. */
export function toClosingPullRequests(data: unknown, repo: TrackerRepoRef): TrackerPullRequest[] {
  const parsed = closingPullsSchema.parse(data);
  const nodes = parsed.repository?.issue?.closedByPullRequestsReferences.nodes ?? [];
  const isSameRepo = (node: (typeof nodes)[number]) =>
    node.repository.owner.login.toLowerCase() === repo.owner.toLowerCase() &&
    node.repository.name.toLowerCase() === repo.name.toLowerCase();
  return nodes
    .filter(node => isSameRepo(node))
    .map(node => {
      const isMerged = node.state === GithubGraphqlPullRequestStates.MERGED;
      let state: TrackerPullRequest['state'] = FeedbackLinkStates.closed;
      if (isMerged) {
        state = FeedbackLinkStates.merged;
      } else if (node.state === GithubGraphqlPullRequestStates.OPEN) {
        state = FeedbackLinkStates.open;
      }
      return {
        number: node.number,
        nodeId: node.id,
        title: node.title,
        url: node.url,
        state,
        mergeCommitSha: isMerged ? (node.mergeCommit?.oid ?? null) : null,
        mergedAt: isMerged ? safeDate(node.mergedAt) : null,
      };
    });
}

const compareSchema = z.object({ status: z.string() });

/** Pure mapper: the compare API's answer for `base...head` -> whether `base` is in `head`'s history.
 * `ahead` (head has commits base lacks) and `identical` mean it is; `behind` and `diverged` mean it
 * isn't. Unit-tested. */
export function isBaseInHead(data: unknown): boolean {
  const { status } = compareSchema.parse(data);
  return status === GithubCompareStatuses.ahead || status === GithubCompareStatuses.identical;
}

/** A number the picker was given (`12`, `#12`), or null for words. */
const NUMBER_QUERY = /^#?(\d{1,10})$/u;

/** Pure: the search API's `q` for words in one repo. Words carrying a qualifier (`repo:…`,
 * `org:…`) are dropped, so the search stays in the repo. Unit-tested. */
export function toSearchQuery(repo: TrackerRepoRef, kind: FeedbackLinkKind, query: string): string {
  // sonarjs/null-dereference is a false positive: `query` and its words are strings, never null.
  /* eslint-disable sonarjs/null-dereference */
  const words = query
    .split(/\s+/u)
    .filter(word => word !== '' && !word.includes(':'))
    .map(word => word.replaceAll('"', ''));
  /* eslint-enable sonarjs/null-dereference */
  const type = kind === FeedbackLinkKinds.pullRequest ? 'is:pr' : 'is:issue';
  return [`repo:${repo.owner}/${repo.name}`, type, ...words].join(' ');
}

/** Mint an installation access token via octokit. A 401/403 here means GitHub's
 * side has uninstalled/suspended the app for this account (not a transient
 * failure) — surfaced as `ProviderConnectionRevokedError` so the caller can flip
 * the connection's status instead of retrying. */
async function mintInstallationOctokit(app: App, externalAccountId: string) {
  try {
    return await app.getInstallationOctokit(Number(externalAccountId));
  } catch (error) {
    const status = octokitStatus(error);
    if (status === 401 || status === 403) {
      throw new ProviderConnectionRevokedError(status, { cause: error });
    }
    throw new GithubApiError('failed to mint installation access token', status, { cause: error });
  }
}

export function createGitHubProvider(
  config: GitHubConfig,
): RepoLister &
  InstallationVerifier &
  CommitSource &
  RepoFileSource &
  RepoArchiveSource &
  RepositoryDispatcher &
  CheckPublisher &
  IssueTracker &
  CommitAncestry {
  const app = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    oauth: { clientId: config.clientId, clientSecret: config.clientSecret },
  });

  // Thin wrapper: the network call + 404→null branch live here; the shape
  // validation/decoding is the pure, unit-tested `decodeGetContent` above.
  const getFileAtCommit: RepoFileSource['getFileAtCommit'] = async (ref, sha, path) => {
    const octokit = await mintInstallationOctokit(app, ref.externalAccountId);
    let data: unknown;
    try {
      ({ data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: ref.owner,
        repo: ref.name,
        path,
        ref: sha,
      }));
    } catch (error) {
      // A repo without the file at this SHA is normal, not an error.
      if (octokitStatus(error) === 404) {
        return null;
      }
      throw new GithubApiError(`failed to fetch ${path}`, octokitStatus(error), { cause: error });
    }
    return decodeGetContent(data);
  };

  /** An issue or pull request by number; null on 404 (none) or 410 (a deleted issue). */
  const getTrackerItem: IssueTracker['get'] = async (ref, kind, number) => {
    const octokit = await mintInstallationOctokit(app, ref.externalAccountId);
    try {
      if (kind === FeedbackLinkKinds.pullRequest) {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner: ref.owner,
          repo: ref.name,
          pull_number: number,
        });
        return toTrackerPull(data);
      }
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner: ref.owner,
        repo: ref.name,
        issue_number: number,
      });
      return toTrackerIssue(data);
    } catch (error) {
      const status = octokitStatus(error);
      if (status === 404 || status === 410) {
        return null;
      }
      throw new GithubApiError(`failed to read ${kind} #${String(number)}`, status, { cause: error });
    }
  };

  return {
    async listRepos(externalAccountId) {
      const octokit = await mintInstallationOctokit(app, externalAccountId);
      try {
        const { data } = await octokit.request('GET /installation/repositories', { per_page: 100 });
        return data.repositories.map(repo => toRepo(repo));
      } catch (error) {
        throw new GithubApiError('failed to list installation repositories', octokitStatus(error), { cause: error });
      }
    },

    async verifyOwnership(code, externalAccountId): Promise<OwnershipResult> {
      try {
        const userOctokit = await app.oauth.getUserOctokit({ code });
        const { data: user } = await userOctokit.request('GET /user');
        const { data: installs } = await userOctokit.request('GET /user/installations', { per_page: 100 });
        const isOwnerVerified = installs.installations.some(
          installation => String(installation.id) === externalAccountId,
        );
        return { ownerVerified: isOwnerVerified, accountLogin: user.login, githubUserId: String(user.id) };
      } catch (error) {
        throw new GithubApiError('failed to verify installation ownership', octokitStatus(error), { cause: error });
      }
    },

    installUrl(state) {
      return `https://github.com/apps/${config.slug}/installations/select_target?state=${encodeURIComponent(state)}`;
    },

    // Bounded backfill: single page, capped at BACKFILL_MAX_LIMIT regardless of
    // what the caller asks for — never an unbounded paginate.
    async listCommits(ref, branch, limit) {
      const octokit = await mintInstallationOctokit(app, ref.externalAccountId);
      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/commits', {
          owner: ref.owner,
          repo: ref.name,
          sha: branch,
          per_page: Math.min(limit, BACKFILL_MAX_LIMIT),
        });
        return data.map(commit => toListedCommit(commit));
      } catch (error) {
        throw new GithubApiError('failed to list repository commits', octokitStatus(error), { cause: error });
      }
    },

    getFileAtCommit,

    // The tarball endpoint redirects to codeload; octokit follows it and hands back the bytes.
    async getArchiveAtCommit(ref, sha) {
      const octokit = await mintInstallationOctokit(app, ref.externalAccountId);
      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/tarball/{ref}', {
          owner: ref.owner,
          repo: ref.name,
          ref: sha,
        });
        return new Uint8Array(data as ArrayBuffer);
      } catch (error) {
        throw new GithubApiError(`failed to fetch the archive at ${sha}`, octokitStatus(error), { cause: error });
      }
    },

    async getConfigAtCommit(ref, sha) {
      return await getFileAtCommit(ref, sha, CONFIG_FILE_PATH);
    },

    // Thin wrapper: mint the installation octokit and fire a repository_dispatch —
    // the neutral trigger the GitHub executor uses to start a workflow. GitHub
    // returns 204 with no body; nothing to map back. A failure is wrapped as a
    // GithubApiError like every other call (the octokit error never escapes).
    async dispatch(ref, eventType, clientPayload) {
      const octokit = await mintInstallationOctokit(app, ref.externalAccountId);
      try {
        await octokit.request('POST /repos/{owner}/{repo}/dispatches', {
          owner: ref.owner,
          repo: ref.name,
          event_type: eventType,
          client_payload: clientPayload,
        });
      } catch (error) {
        throw new GithubApiError('failed to dispatch repository event', octokitStatus(error), { cause: error });
      }
    },

    // A completed check run in one call: the report is final when it's written.
    async publishCheck(ref, report) {
      const octokit = await mintInstallationOctokit(app, ref.externalAccountId);
      try {
        await octokit.request('POST /repos/{owner}/{repo}/check-runs', {
          owner: ref.owner,
          repo: ref.name,
          ...toCheckRunBody(report),
        });
      } catch (error) {
        throw new GithubApiError('failed to create a check run', octokitStatus(error), { cause: error });
      }
    },

    // A number goes straight to the item; words go to the search API, kept to the repo.
    async search(ref, kind, query, limit) {
      // eslint-disable-next-line sonarjs/null-dereference -- `query` is a string, never null
      const asNumber = NUMBER_QUERY.exec(query.trim());
      if (asNumber?.[1] !== undefined) {
        const item = await getTrackerItem(ref, kind, Number(asNumber[1]));
        return item === null ? [] : [item];
      }
      const octokit = await mintInstallationOctokit(app, ref.externalAccountId);
      try {
        const { data } = await octokit.request('GET /search/issues', {
          q: toSearchQuery(ref, kind, query),
          sort: 'updated',
          order: 'desc',
          per_page: limit,
        });
        return toTrackerSearchItems(data, ref, kind).slice(0, limit);
      } catch (error) {
        throw new GithubApiError(`failed to search ${kind}s`, octokitStatus(error), { cause: error });
      }
    },

    get: getTrackerItem,

    async closingPullRequests(ref, issueNumber) {
      const octokit = await mintInstallationOctokit(app, ref.externalAccountId);
      let data: unknown;
      try {
        data = await octokit.graphql(CLOSING_PULL_REQUESTS_QUERY, {
          owner: ref.owner,
          name: ref.name,
          number: issueNumber,
        });
      } catch (error) {
        throw new GithubApiError(
          `failed to read the pull requests closing #${String(issueNumber)}`,
          octokitStatus(error),
          {
            cause: error,
          },
        );
      }
      return toClosingPullRequests(data, ref);
    },

    // One commit (`per_page: 1`) is enough: only the comparison's status is read. A 404 is a SHA
    // the repo doesn't have (force-pushed away and collected), so it isn't in the history.
    async containsCommit(ref, ancestorSha, headSha) {
      if (ancestorSha === headSha) {
        return true;
      }
      const octokit = await mintInstallationOctokit(app, ref.externalAccountId);
      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
          owner: ref.owner,
          repo: ref.name,
          basehead: `${ancestorSha}...${headSha}`,
          per_page: 1,
        });
        return isBaseInHead(data);
      } catch (error) {
        const status = octokitStatus(error);
        if (status === 404) {
          return false;
        }
        throw new GithubApiError(`failed to compare ${ancestorSha} with ${headSha}`, status, { cause: error });
      }
    },
  };
}

export type GitHubProvider = ReturnType<typeof createGitHubProvider>;
