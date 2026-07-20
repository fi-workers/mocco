// Production composition root for the integration domain. Lazy so builds don't
// need env at import. Returns undefined when the GitHub App isn't configured, so
// a deploy without GitHub set up still serves every non-integration route — only
// the integration surfaces report "not configured" (enforced by the router
// middleware / ext route).
import { CommitConfigService } from '@backend/domain/integration/CommitConfigService';
import { CommitSyncService } from '@backend/domain/integration/CommitSyncService';
import { ConnectionService } from '@backend/domain/integration/ConnectionService';
import { createGitHubProvider, type GitHubProvider } from '@backend/domain/integration/github/provider';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { ConnectStateRepo } from '@backend/domain/integration/repos/connect-state.repo';
import { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { WebhookDeliveryRepo } from '@backend/domain/integration/repos/webhook-delivery.repo';
import { MoccoConfigParser } from '@backend/domain/pipeline/MoccoConfigParser';
import { decodeYaml } from '@backend/domain/pipeline/yaml/decode';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

export interface Integration {
  connection: ConnectionService;
  commitSync: CommitSyncService;
  /** Snapshots/reads a commit's `.mocco.yml` — also injected into `commitSync` as its `configs` dep. */
  commitConfig: CommitConfigService;
  provider: GitHubProvider;
  /** Delivery-dedupe repo — used by the ext webhook route for idempotency. */
  deliveries: WebhookDeliveryRepo;
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
      // Shared repo instances — both services reach the same mocco_ tables, no
      // reason to duplicate the wrapper per service.
      const connections = new ProviderConnectionRepo(db);
      const repos = new RepoRepo(db);
      const connectStates = new ConnectStateRepo(db);
      const deliveries = new WebhookDeliveryRepo(db);
      const commits = new CommitRepo(db);
      // Constructed once and injected — MoccoConfigParser is a stateless domain
      // object, never `new`'d inside a service (see CommitConfigServiceDeps).
      const parser = new MoccoConfigParser(decodeYaml);
      const commitConfig = new CommitConfigService({
        configs: new CommitConfigRepo(db),
        commits,
        source: provider,
        parser,
      });
      state.integration = {
        connection: new ConnectionService({ connections, repos, connectStates, provider }),
        commitSync: new CommitSyncService({
          commits,
          deliveries,
          connections,
          repos,
          connectStates,
          source: provider,
          configs: commitConfig,
        }),
        commitConfig,
        provider,
        deliveries,
      };
    }
  }
  return state.integration;
}
