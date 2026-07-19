// Production composition root for the integration domain. Lazy so builds don't
// need env at import. Returns undefined when the GitHub App isn't configured, so
// a deploy without GitHub set up still serves every non-integration route — only
// the integration surfaces report "not configured" (enforced by the router
// middleware / ext route).
import { ConnectionService } from '@backend/domain/integration/ConnectionService';
import { createGitHubProvider, type GitHubProvider } from '@backend/domain/integration/github/provider';
import { ConnectStateRepo } from '@backend/domain/integration/repos/connect-state.repo';
import { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

export interface Integration {
  connection: ConnectionService;
  provider: GitHubProvider;
}

const state: { integration?: Integration } = {};

/** The integration services, or `undefined` if the GitHub App env vars are absent. */
export function getIntegration(): Integration | undefined {
  if (!state.integration) {
    const env = getEnv();
    if (
      env.GITHUB_APP_ID !== undefined &&
      env.GITHUB_APP_SLUG !== undefined &&
      env.GITHUB_APP_PRIVATE_KEY_B64 !== undefined &&
      env.GITHUB_APP_CLIENT_ID !== undefined &&
      env.GITHUB_APP_CLIENT_SECRET !== undefined
    ) {
      const provider = createGitHubProvider({
        appId: env.GITHUB_APP_ID,
        slug: env.GITHUB_APP_SLUG,
        privateKey: env.GITHUB_APP_PRIVATE_KEY_B64,
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      });
      const db = getDb();
      state.integration = {
        connection: new ConnectionService({
          connections: new ProviderConnectionRepo(db),
          repos: new RepoRepo(db),
          connectStates: new ConnectStateRepo(db),
          provider,
        }),
        provider,
      };
    }
  }
  return state.integration;
}
