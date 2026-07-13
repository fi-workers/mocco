import { randomUUID } from 'node:crypto';

import { Providers } from '@mocco/common/integration';
import { and, eq, gt, isNull } from 'drizzle-orm';

import * as schema from '../../infra/db/schema';

import { ConnectStateInvalidError, ProviderConnectionNotFoundError, RepoNotFoundError } from './errors';

import type { InstallationVerifier, RepoLister } from './ports';
import type { AvailableRepoDto, RepoAddInput } from '@mocco/common/integration';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

// Broad enough for both the prod node-postgres db and the pglite test db (both
// carry `typeof schema`); client.ts's concrete `Db` is node-postgres-only.
type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A single-row insert/update always returns one row; assert it for a non-undefined return type. */
function first<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected a row from a single-row write');
  }
  return row;
}

/** How long an install-handshake `state` stays valid. */
const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

export interface ConnectionServiceDeps {
  db: Db;
  provider: RepoLister & InstallationVerifier;
}

/**
 * Owns the integration's own mocco_ tables directly (unlike auth, which goes
 * through the vendor). Enforces the tenant-isolation invariant: a repo is only
 * ever reached via (connection_id, external_repo_id) with the connection scoped
 * to the caller's workspace — never by external_repo_id alone.
 */
export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  private async requireConnection(workspaceId: string, connectionId: string) {
    const [row] = await this.deps.db
      .select()
      .from(schema.providerConnections)
      .where(
        and(eq(schema.providerConnections.id, connectionId), eq(schema.providerConnections.workspaceId, workspaceId)),
      );
    if (row === undefined) {
      throw new ProviderConnectionNotFoundError(connectionId);
    }
    return row;
  }

  /** Begin an install: persist a single-use, TTL'd state bound to the user+workspace; return the provider install URL. */
  async startInstall(userId: string, workspaceId: string): Promise<{ installUrl: string }> {
    const state = randomUUID();
    const expiresAt = new Date(Date.now() + CONNECT_STATE_TTL_MS);
    await this.deps.db.insert(schema.githubConnectStates).values({ state, userId, workspaceId, expiresAt });
    return { installUrl: this.deps.provider.installUrl(state) };
  }

  /**
   * Atomically consume an install `state` for `userId`; returns the target workspace.
   * The WHERE clause (unconsumed AND unexpired AND owned by the user) does the work —
   * an unknown / already-consumed / expired / foreign state updates zero rows.
   */
  async consumeConnectState(state: string, userId: string): Promise<{ workspaceId: string }> {
    const now = new Date();
    const [row] = await this.deps.db
      .update(schema.githubConnectStates)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.githubConnectStates.state, state),
          eq(schema.githubConnectStates.userId, userId),
          isNull(schema.githubConnectStates.consumedAt),
          gt(schema.githubConnectStates.expiresAt, now),
        ),
      )
      .returning();
    if (row === undefined) {
      throw new ConnectStateInvalidError();
    }
    return { workspaceId: row.workspaceId };
  }

  /** Upsert a connection keyed on (provider, external_account_id). */
  async createConnection(workspaceId: string, input: { externalAccountId: string; accountLogin: string }) {
    return first(
      await this.deps.db
        .insert(schema.providerConnections)
        .values({
          workspaceId,
          provider: Providers.github,
          externalAccountId: input.externalAccountId,
          accountLogin: input.accountLogin,
        })
        .onConflictDoUpdate({
          target: [schema.providerConnections.provider, schema.providerConnections.externalAccountId],
          set: { workspaceId, accountLogin: input.accountLogin, status: 'active' },
        })
        .returning(),
    );
  }

  async listConnections(workspaceId: string) {
    return await this.deps.db
      .select()
      .from(schema.providerConnections)
      .where(eq(schema.providerConnections.workspaceId, workspaceId));
  }

  async listRepos(workspaceId: string) {
    return await this.deps.db.select().from(schema.repos).where(eq(schema.repos.workspaceId, workspaceId));
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
    return first(
      await this.deps.db
        .insert(schema.repos)
        .values({
          workspaceId,
          connectionId: connection.id,
          externalRepoId: match.externalRepoId,
          owner: match.owner,
          name: match.name,
          defaultBranch: match.defaultBranch,
          watchedBranch: input.watchedBranch,
        })
        .onConflictDoUpdate({
          target: [schema.repos.connectionId, schema.repos.externalRepoId],
          set: { watchedBranch: input.watchedBranch, status: 'active' },
        })
        .returning(),
    );
  }

  async setWatchedBranch(workspaceId: string, repoId: string, watchedBranch: string | null) {
    const [row] = await this.deps.db
      .update(schema.repos)
      .set({ watchedBranch })
      .where(and(eq(schema.repos.id, repoId), eq(schema.repos.workspaceId, workspaceId)))
      .returning();
    if (row === undefined) {
      throw new RepoNotFoundError(repoId);
    }
    return row;
  }
}
