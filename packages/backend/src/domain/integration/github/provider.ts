import { createHmac, timingSafeEqual } from 'node:crypto';

import { App } from '@octokit/app';

import { BACKFILL_MAX_LIMIT } from '@backend/domain/integration/constants';
import { GithubWebhookEvents, SIGNATURE_ALGORITHM, WebhookKinds } from '@backend/domain/integration/github/constants';
import {
  GithubApiError,
  octokitStatus,
  ProviderConnectionRevokedError,
  WebhookParseError,
} from '@backend/domain/integration/github/errors';
import {
  installationEventSchema,
  installationRepositoriesEventSchema,
  pushEventSchema,
} from '@backend/domain/integration/github/webhook-events';

import type { ParsedWebhook } from '@backend/domain/integration/github/webhook-events';
import type {
  CommitSource,
  InstallationVerifier,
  OwnershipResult,
  RepoLister,
  SourceCommit,
} from '@backend/domain/integration/ports';
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
 * this function. An event type we don't act on maps to `{ kind: 'ignored' }`
 * without needing the body to parse at all.
 * sonarjs/function-return-type is a false positive here: the return type is
 * the ParsedWebhook discriminated union declared above; each branch legitimately
 * returns a different member of that single union. */
// eslint-disable-next-line sonarjs/function-return-type
export function parseWebhook(eventType: string | null, rawBody: string): ParsedWebhook {
  if (
    eventType !== GithubWebhookEvents.push &&
    eventType !== GithubWebhookEvents.installation &&
    eventType !== GithubWebhookEvents.installation_repositories
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
    return { kind: WebhookKinds.installation_repositories, data: installationRepositoriesEventSchema.parse(json) };
  } catch (error) {
    throw new WebhookParseError(eventType, { cause: error });
  }
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

export function createGitHubProvider(config: GitHubConfig): RepoLister & InstallationVerifier & CommitSource {
  const app = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    oauth: { clientId: config.clientId, clientSecret: config.clientSecret },
  });

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
  };
}

export type GitHubProvider = ReturnType<typeof createGitHubProvider>;
