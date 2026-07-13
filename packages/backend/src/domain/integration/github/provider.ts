import { App } from '@octokit/app';

import { GithubApiError, octokitStatus } from './errors';

import type { InstallationVerifier, OwnershipResult, RepoLister } from '../ports';
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

export function createGitHubProvider(config: GitHubConfig): RepoLister & InstallationVerifier {
  const app = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    oauth: { clientId: config.clientId, clientSecret: config.clientSecret },
  });

  return {
    async listRepos(externalAccountId) {
      try {
        const octokit = await app.getInstallationOctokit(Number(externalAccountId));
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
  };
}

export type GitHubProvider = ReturnType<typeof createGitHubProvider>;
