import { CommitNotFoundError } from '@backend/domain/integration/errors';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { CommitSource } from '@backend/domain/integration/ports';
import type { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import type { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import type { MoccoConfigParser } from '@backend/domain/pipeline/MoccoConfigParser';
import type { CommitConfigDto, CommitDetailDto } from '@mocco/common/integration';

// Row/ref shapes are taken from the ports/repos (a service never imports the drizzle
// schema) — mirrors the convention in CommitSyncService.
type CommitRow = Awaited<ReturnType<CommitRepo['getByIdInWorkspace']>>;
type Ref = Parameters<CommitSource['getConfigAtCommit']>[0];

export interface CommitConfigServiceDeps {
  configs: CommitConfigRepo;
  commits: CommitRepo;
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
 * `mocco_commit_configs.present` mirrors the wire DTO's `present: boolean`
 * 1:1: a stored row always exists once a commit has been snapshotted, and
 * `present` distinguishes "the tree had a `.mocco.yml`" (`true`, with the
 * parsed content) from "we looked and there was none" (`false`, with an
 * empty `rawYaml` marker and no parsed config). `config: null` in
 * `CommitDetailDto` means only one thing: this commit has never been
 * snapshotted at all.
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
   * Fetch, parse, and snapshot one commit's `.mocco.yml`. Best-effort: any
   * failure for this commit — fetch, parse, or the DB upsert — is logged and
   * swallowed, never thrown, so one bad commit can't sink a
   * `snapshotForCommits` batch.
   */
  async snapshotCommit(ref: Ref, commitRow: CommitRow): Promise<void> {
    try {
      const raw = await this.deps.source.getConfigAtCommit(ref, commitRow.sha);
      if (raw === null) {
        // No `.mocco.yml` in this commit's tree — store an explicit absent marker.
        await this.deps.configs.upsert({
          commitId: commitRow.id,
          present: false,
          rawYaml: '',
          parsedJson: null,
          valid: false,
          validationErrors: [],
        });
        return;
      }

      const result = this.deps.parser.parse(raw);
      await this.deps.configs.upsert({
        commitId: commitRow.id,
        present: true,
        rawYaml: raw,
        parsedJson: result.ok ? result.config : null,
        valid: result.ok,
        validationErrors: result.ok ? [] : result.issues,
      });
    } catch (error) {
      console.error(`[commit-config] snapshotCommit failed for commit ${commitRow.id} (${commitRow.sha})`, error);
    }
  }

  /** Snapshot a batch of commits under one repo/ref. Bounded by the caller;
   * throttled by the octokit plugin underneath the real CommitSource — each
   * commit is isolated (see snapshotCommit), so running the batch concurrently
   * is safe: one failure never blocks or drops another commit's snapshot. */
  async snapshotForCommits(ref: Ref, commitRows: CommitRow[]): Promise<void> {
    await Promise.all(commitRows.map(async commitRow => await this.snapshotCommit(ref, commitRow)));
  }

  /** A commit plus its config snapshot, workspace-scoped. `config: null` means
   * the commit hasn't been snapshotted yet; a snapshotted commit always
   * returns a `CommitConfigDto` with `present` reflecting whether its tree
   * had a `.mocco.yml` at snapshot time. */
  async getDetail(workspaceId: string, commitId: string): Promise<CommitDetailDto> {
    const commit = await this.requireCommit(workspaceId, commitId);
    const snapshot = await this.deps.configs.findByCommitId(commitId);

    const config: CommitConfigDto | null =
      snapshot === undefined
        ? null
        : {
            present: snapshot.present,
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
