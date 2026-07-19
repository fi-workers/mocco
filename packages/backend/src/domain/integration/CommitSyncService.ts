import { Providers } from '@mocco/common/integration';

import { BACKFILL_DEFAULT_LIMIT, ConnectionStatuses } from '@backend/domain/integration/constants';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { ParsedWebhook } from '@backend/domain/integration/github/webhook-events';
import type { CommitSource, SourceCommit } from '@backend/domain/integration/ports';
import type { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import type { ConnectStateRepo } from '@backend/domain/integration/repos/connect-state.repo';
import type { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import type { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import type { WebhookDeliveryRepo } from '@backend/domain/integration/repos/webhook-delivery.repo';

type PushData = Extract<ParsedWebhook, { kind: 'push' }>['data'];
type InstallationData = Extract<ParsedWebhook, { kind: 'installation' }>['data'];
// Row shapes are taken from the repos (a service never imports the drizzle schema).
type RepoRow = Awaited<ReturnType<RepoRepo['getByConnectionAndExternalRepoId']>>;
type CommitInsert = Parameters<CommitRepo['upsertMany']>[0][number];

const BRANCH_REF_PREFIX = 'refs/heads/';

/** Map a neutral SourceCommit onto an insertable commit row for a repo+branch. */
function toCommitRow(repoId: string, branch: string): (c: SourceCommit) => CommitInsert {
  return c => ({
    repoId,
    sha: c.sha,
    branch,
    message: c.message,
    authorName: c.authorName,
    authorEmail: c.authorEmail,
    committedAt: c.committedAt,
  });
}

export interface CommitSyncServiceDeps {
  commits: CommitRepo;
  /** Reserved for route-level delivery dedupe (wired in Task 8). */
  deliveries: WebhookDeliveryRepo;
  connections: ProviderConnectionRepo;
  repos: RepoRepo;
  source: CommitSource;
  connectStates: ConnectStateRepo;
}

/**
 * Turns provider webhooks into synced commit rows and applies installation-lifecycle
 * transitions. Like ConnectionService it reaches the DB only through repositories.
 *
 * This service owns the **tenant-isolation invariant**: a push carries only a global
 * `installation_id` and a provider `repository.id`, neither of which is workspace-scoped.
 * The ONLY safe resolution is `installation_id → connection → repo by (connection_id,
 * external_repo_id)`. A repo is NEVER looked up by `external_repo_id` alone — two
 * workspaces can legitimately register the same external repo, and resolving globally
 * would leak one tenant's commits into another. Anything that can't be resolved to a
 * watched repo is *parked* (logged and dropped), never thrown — webhooks are fire-and-forget.
 */
export class CommitSyncService {
  constructor(private readonly deps: CommitSyncServiceDeps) {}

  /**
   * Claim a pending connect-state for the installing user and create the connection.
   * The webhook has no `state`, so we match on the installing user's github id (`sender.id`)
   * against an unconsumed, unexpired connect-state (stamped with `github_user_id` by the
   * setup redirect). If none matches, the install is *unclaimed* — parked, not created.
   * Mirrors ConnectionService.createConnection's upsert, but a claimed installation is
   * parked (webhooks can't surface an error) rather than throwing ConnectionClaimedError.
   */
  private async reconcileInstallationCreated(data: InstallationData, externalAccountId: string): Promise<void> {
    const consumed = await this.deps.connectStates.consumeByGithubUserId(String(data.sender.id), new Date());
    if (consumed === undefined) {
      console.warn(
        `[commit-sync] installation.created ${externalAccountId} — no pending connect-state, parked unclaimed`,
      );
      return;
    }
    const existing = await this.deps.connections.findByExternalAccount(Providers.github, externalAccountId);
    if (existing !== undefined && existing.workspaceId !== consumed.workspaceId) {
      // Installation is globally unique and already belongs elsewhere — never silently reassign.
      console.warn(
        `[commit-sync] installation.created ${externalAccountId} already claimed by another workspace — parked`,
      );
      return;
    }
    await this.deps.connections.upsert(consumed.workspaceId, Providers.github, {
      externalAccountId,
      accountLogin: data.installation.account.login,
    });
  }

  /** Route a parsed webhook to its handler. The webhook route calls this in `waitUntil`. */
  async handle(parsed: ParsedWebhook): Promise<void> {
    if (parsed.kind === 'push') {
      await this.syncPush(parsed.data);
      return;
    }
    if (parsed.kind === 'installation') {
      await this.handleInstallation(parsed.data);
      return;
    }
    if (parsed.kind === 'installation_repositories') {
      // Repo-set changes are observed but not reconciled here (slice 3b): repos are
      // added/removed explicitly via ConnectionService. Log-only, by design.
      console.warn(
        `[commit-sync] installation_repositories '${parsed.data.action}' for installation ${parsed.data.installation.id} — logged, not reconciled`,
      );
    }
    // kind === 'ignored' → no-op
  }

  /** Sync the commits carried by a push, tenant-scoped through the connection. */
  async syncPush(data: PushData): Promise<void> {
    const externalAccountId = String(data.installation.id);
    const connection = await this.deps.connections.findByExternalAccount(Providers.github, externalAccountId);
    if (connection === undefined) {
      // No workspace has connected this installation — nothing to attribute the push to.
      console.warn(`[commit-sync] push for unconnected installation ${externalAccountId} — parked`);
      return;
    }

    if (!data.ref.startsWith(BRANCH_REF_PREFIX)) {
      return; // tag push / non-branch ref — not a branch we could watch
    }
    const branch = data.ref.slice(BRANCH_REF_PREFIX.length);

    let repo: RepoRow;
    try {
      repo = await this.deps.repos.getByConnectionAndExternalRepoId(connection.id, String(data.repository.id));
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        // The installation is connected, but this repo isn't registered under it — park.
        console.warn(
          `[commit-sync] push for unregistered repo ${data.repository.id} under installation ${externalAccountId} — parked`,
        );
        return;
      }
      throw error;
    }

    if (repo.watchedBranch !== branch) {
      return; // push is on a branch this repo doesn't watch
    }

    const rows = data.commits
      .map((c): SourceCommit => ({
        sha: c.id,
        message: c.message,
        authorName: c.author.name,
        authorEmail: c.author.email,
        committedAt: new Date(c.timestamp),
      }))
      .map(toCommitRow(repo.id, branch));
    await this.deps.commits.upsertMany(rows);
    await this.deps.repos.touchLastSynced(repo.id);
  }

  /** Best-effort backfill of recent history for a freshly-watched repo. Never throws. */
  async backfillRepo(repo: RepoRow): Promise<void> {
    try {
      if (repo.watchedBranch === null) {
        return; // nothing to backfill until a branch is watched
      }
      const connection = await this.deps.connections.getById(repo.workspaceId, repo.connectionId);
      const commits = await this.deps.source.listCommits(
        { externalAccountId: connection.externalAccountId, owner: repo.owner, name: repo.name },
        repo.watchedBranch,
        BACKFILL_DEFAULT_LIMIT,
      );
      await this.deps.commits.upsertMany(commits.map(toCommitRow(repo.id, repo.watchedBranch)));
      await this.deps.repos.touchLastSynced(repo.id);
    } catch (error) {
      // Backfill is opportunistic — a provider hiccup must not fail the caller (e.g. addRepo).
      console.error(`[commit-sync] backfill failed for repo ${repo.id}`, error);
    }
  }

  /** Apply an installation-lifecycle transition (global key = provider + installation id). */
  async handleInstallation(data: InstallationData): Promise<void> {
    const externalAccountId = String(data.installation.id);
    if (data.action === 'deleted') {
      const connection = await this.deps.connections.findByExternalAccount(Providers.github, externalAccountId);
      if (connection === undefined) {
        console.warn(`[commit-sync] installation.deleted for unconnected installation ${externalAccountId} — parked`);
        return;
      }
      await this.deps.connections.updateStatusByExternalAccount(
        Providers.github,
        externalAccountId,
        ConnectionStatuses.deleted,
      );
      await this.deps.repos.inactivateByConnection(connection.id);
      return;
    }
    if (data.action === 'suspend') {
      await this.deps.connections.updateStatusByExternalAccount(
        Providers.github,
        externalAccountId,
        ConnectionStatuses.suspended,
      );
      return;
    }
    if (data.action === 'unsuspend') {
      await this.deps.connections.updateStatusByExternalAccount(
        Providers.github,
        externalAccountId,
        ConnectionStatuses.active,
      );
      return;
    }
    if (data.action === 'created') {
      await this.reconcileInstallationCreated(data, externalAccountId);
    }
    // action === 'new_permissions_accepted' → no state change we track
  }
}
