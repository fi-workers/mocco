import { randomUUID } from 'node:crypto';

import { Providers } from '@mocco/common/integration';

import {
  ConnectionClaimedError,
  ConnectStateInvalidError,
  ProviderConnectionNotFoundError,
  RepoNotFoundError,
} from '@backend/domain/integration/errors';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { InstallationVerifier, RepoLister } from '@backend/domain/integration/ports';
import type { ConnectStateRepo } from '@backend/domain/integration/repos/connect-state.repo';
import type { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import type { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import type { AvailableRepoDto, RepoAddInput } from '@mocco/common/integration';

/** How long an install-handshake `state` stays valid. */
const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

export interface ConnectionServiceDeps {
  connections: ProviderConnectionRepo;
  repos: RepoRepo;
  connectStates: ConnectStateRepo;
  provider: RepoLister & InstallationVerifier;
}

/**
 * Owns the integration's own mocco_ tables (unlike auth, which goes through the
 * vendor) — but reaches them only through repositories, never drizzle directly.
 * Policy layer: maps the repos' EntityNotFoundError to domain errors and enforces
 * the tenant-isolation invariant (repos are only ever reached workspace-scoped).
 */
export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  private async requireConnection(workspaceId: string, connectionId: string) {
    try {
      return await this.deps.connections.getById(workspaceId, connectionId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new ProviderConnectionNotFoundError(connectionId, { cause: error });
      }
      throw error;
    }
  }

  /** Begin an install: persist a single-use, TTL'd state bound to the user+workspace; return the provider install URL. */
  async startInstall(userId: string, workspaceId: string): Promise<{ installUrl: string }> {
    const state = randomUUID();
    const expiresAt = new Date(Date.now() + CONNECT_STATE_TTL_MS);
    await this.deps.connectStates.insert({ state, userId, workspaceId, expiresAt });
    return { installUrl: this.deps.provider.installUrl(state) };
  }

  /**
   * Atomically consume an install `state` for `userId`; returns the target workspace.
   * The repo returns the raw connect-state row; this service is the narrowing boundary
   * for the ext (Hono) path — which has no tRPC `.output()` — so it projects to the DTO
   * explicitly here (the runtime object must match the declared shape, not just the type).
   */
  async consumeConnectState(state: string, userId: string): Promise<{ workspaceId: string }> {
    const consumed = await this.deps.connectStates.consume(state, userId, new Date());
    if (consumed === undefined) {
      throw new ConnectStateInvalidError();
    }
    return { workspaceId: consumed.workspaceId };
  }

  /**
   * Upsert a connection keyed on (provider, external_account_id). An installation
   * is globally unique and stays with the workspace it was first connected to;
   * re-connecting it to a different workspace is rejected (rather than silently
   * moved, or crashing on the composite FK when the origin workspace has repos).
   */
  async createConnection(workspaceId: string, input: { externalAccountId: string; accountLogin: string }) {
    const existing = await this.deps.connections.findByExternalAccount(Providers.github, input.externalAccountId);
    if (existing !== undefined && existing.workspaceId !== workspaceId) {
      throw new ConnectionClaimedError(input.externalAccountId);
    }
    return await this.deps.connections.upsert(workspaceId, Providers.github, input);
  }

  async listConnections(workspaceId: string) {
    return await this.deps.connections.findByWorkspace(workspaceId);
  }

  async listRepos(workspaceId: string) {
    return await this.deps.repos.findByWorkspace(workspaceId);
  }

  /** Live list (from the provider) of repos the connection can access. Connection must belong to the workspace. */
  async availableRepos(workspaceId: string, connectionId: string): Promise<AvailableRepoDto[]> {
    const connection = await this.requireConnection(workspaceId, connectionId);
    return await this.deps.provider.listRepos(connection.externalAccountId);
  }

  /** Register a repo under a connection. owner/name/defaultBranch are taken authoritatively from the provider. */
  async addRepo(workspaceId: string, input: RepoAddInput) {
    const connection = await this.requireConnection(workspaceId, input.connectionId);
    const available = await this.deps.provider.listRepos(connection.externalAccountId);
    const match = available.find(repo => repo.externalRepoId === input.externalRepoId);
    if (match === undefined) {
      throw new RepoNotFoundError(input.externalRepoId);
    }
    return await this.deps.repos.upsert({
      workspaceId,
      connectionId: connection.id,
      externalRepoId: match.externalRepoId,
      owner: match.owner,
      name: match.name,
      defaultBranch: match.defaultBranch,
      watchedBranch: input.watchedBranch,
    });
  }

  async setWatchedBranch(workspaceId: string, repoId: string, watchedBranch: string | null) {
    try {
      return await this.deps.repos.updateWatchedBranch(workspaceId, repoId, watchedBranch);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new RepoNotFoundError(repoId, { cause: error });
      }
      throw error;
    }
  }
}
