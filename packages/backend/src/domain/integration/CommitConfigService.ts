import { CommitNotFoundError } from '@backend/domain/integration/errors';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { CommitSource } from '@backend/domain/integration/ports';
import type { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import type { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import type { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import type { MoccoConfigParser } from '@backend/domain/pipeline/MoccoConfigParser';
import type { CommitConfigDto, CommitDetailDto } from '@mocco/common/integration';

// Row/ref shapes are taken from the ports/repos (a service never imports the drizzle
// schema) — mirrors the convention in CommitSyncService.
type CommitRow = Awaited<ReturnType<CommitRepo['getByIdInWorkspace']>>;
type Ref = Parameters<CommitSource['getConfigAtCommit']>[0];

export interface CommitConfigServiceDeps {
  configs: CommitConfigRepo;
  commits: CommitRepo;
  repos: RepoRepo;
  source: CommitSource;
  /** Stateless domain object — construct once at the composition root with a
   * `YamlDecoder` and inject it here. Never `new`'d inside this service. */
  parser: MoccoConfigParser;
}

/**
 * Fetches a repo's `.mocco.yml` at a commit SHA, parses it, and snapshots the
 * result onto `mocco_commit_configs` — plus the workspace-scoped detail read
 * that assembles a commit with its snapshot into the wire `CommitDetailDto`.
 * Like ConnectionService/CommitSyncService, it reaches the DB only through
 * repositories and maps their `EntityNotFoundError` to a domain error.
 *
 * ## Known gap: "absent" (`present: false`) is not representable today
 *
 * `commitConfigSchema` (the wire DTO) carries a `present: boolean` field —
 * `present: false` means "we looked, and this commit's tree has no
 * `.mocco.yml`". But the `mocco_commit_configs` TABLE has no `present` column
 * (see `packages/backend/src/infra/db/schema.ts`): only `rawYaml` (not null),
 * `parsedJson`, `valid` (not null), and `validationErrors` (not null).
 *
 * Every heuristic that tries to encode "absent" using those columns alone is
 * fragile — e.g. treating `rawYaml === '' && !valid && validationErrors.length
 * === 0` as "absent" would also misclassify a genuinely empty-but-present
 * `.mocco.yml` that happens to fail parsing with a message-less issue. Making
 * `rawYaml` nullable, or adding a real `present` column, both require a schema
 * migration — out of this service's scope.
 *
 * So `snapshotCommit` deliberately does **not** store a row when the source
 * reports no config at a commit (`getConfigAtCommit` returns `null`). This
 * keeps every stored row unambiguous (a row only ever exists for a commit
 * whose tree DID have a `.mocco.yml` at snapshot time), at the cost of
 * collapsing two DTO-level states into one on read: `getDetail` returns
 * `config: null` both for "never snapshotted" and for "snapshotted, file
 * absent". `present: false` is consequently unreachable via this path today.
 * Closing this gap needs a schema column — flagged for the router task (8)
 * rather than guessed at here.
 */
export class CommitConfigService {
  constructor(private readonly deps: CommitConfigServiceDeps) {}

  /** A commit owned by the workspace, or throw CommitNotFoundError. A commit is
   * NEVER resolved by id alone — always through the workspace-scoped repo join. */
  private async requireCommit(workspaceId: string, commitId: string): Promise<CommitRow> {
    try {
      return await this.deps.commits.getByIdInWorkspace(workspaceId, commitId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new CommitNotFoundError(commitId, { cause: error });
      }
      throw error;
    }
  }

  /**
   * Fetch, parse, and snapshot one commit's `.mocco.yml`. Best-effort: a
   * `getConfigAtCommit` failure for this commit is logged and swallowed —
   * never thrown — so one bad commit can't sink a `snapshotForCommits` batch.
   */
  async snapshotCommit(ref: Ref, commitRow: CommitRow): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.deps.source.getConfigAtCommit(ref, commitRow.sha);
    } catch (error) {
      console.error(`[commit-config] getConfigAtCommit failed for commit ${commitRow.id} (${commitRow.sha})`, error);
      return;
    }
    if (raw === null) {
      // No `.mocco.yml` in this commit's tree — see the class doc for why no row is stored.
      return;
    }

    const result = this.deps.parser.parse(raw);
    await this.deps.configs.upsert({
      commitId: commitRow.id,
      rawYaml: raw,
      parsedJson: result.ok ? result.config : null,
      valid: result.ok,
      validationErrors: result.ok ? [] : result.issues,
    });
  }

  /** Snapshot a batch of commits under one repo/ref. Bounded by the caller;
   * throttled by the octokit plugin underneath the real CommitSource — each
   * commit is isolated (see snapshotCommit), so running the batch concurrently
   * is safe: one failure never blocks or drops another commit's snapshot. */
  async snapshotForCommits(ref: Ref, commitRows: CommitRow[]): Promise<void> {
    await Promise.all(commitRows.map(async commitRow => await this.snapshotCommit(ref, commitRow)));
  }

  /** A commit plus its config snapshot, workspace-scoped. `config: null` means
   * either the commit hasn't been snapshotted yet, or (see the class doc) the
   * snapshot found no `.mocco.yml` — the two are not distinguished today. */
  async getDetail(workspaceId: string, commitId: string): Promise<CommitDetailDto> {
    const commit = await this.requireCommit(workspaceId, commitId);
    const snapshot = await this.deps.configs.findByCommitId(commitId);

    const config: CommitConfigDto | null =
      snapshot === undefined
        ? null
        : {
            present: true,
            valid: snapshot.valid,
            config: snapshot.parsedJson as CommitConfigDto['config'],
            issues: snapshot.validationErrors as CommitConfigDto['issues'],
          };

    return {
      commit: {
        id: commit.id,
        repoId: commit.repoId,
        seq: commit.seq.toString(),
        sha: commit.sha,
        branch: commit.branch,
        message: commit.message,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        committedAt: commit.committedAt,
      },
      config,
    };
  }
}
