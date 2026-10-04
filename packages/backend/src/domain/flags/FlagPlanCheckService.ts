// The flags plan check on a pull request (#146): when a PR into the default branch
// changes `.mocco/flags.yml`, report on the PR what merging it would do in every project
// the repo is linked to. It plans the PR's file against each project as it is now (the
// same planning the merge's sync does), not against the base branch's file: the console
// may have changed things since. It only reads; the merge is still what changes Mocco,
// and the check never blocks it.
import { FLAGS_FILE_PATH } from '@mocco/common/flags-file';

import { parseFlagsFile, planFlagsFile } from '@backend/domain/flags/flags-file';
import { readFlagsHead } from '@backend/domain/flags/flags-head';
import { renderPlanCheck } from '@backend/domain/flags/plan-check-report';
import { FlagFileSyncRepo } from '@backend/domain/flags/repos/flag-file-sync.repo';
import { decodeYaml } from '@backend/domain/pipeline/yaml/decode';

import type { FlagsFileParse } from '@backend/domain/flags/flags-file';
import type { PlanCheckProject } from '@backend/domain/flags/plan-check-report';
import type { CheckPublisher, RepoFileSource } from '@backend/domain/integration/ports';
import type { YamlDecoder } from '@backend/domain/pipeline/yaml/decode';
import type { Db } from '@backend/infra/db/types';

/** A pull request into a repo's default branch, as the integration domain hands it over. */
export interface FlagPlanPullRequest {
  workspaceId: string;
  repoId: string;
  ref: { externalAccountId: string; owner: string; name: string };
  number: number;
  headSha: string;
  baseSha: string;
}

export interface FlagPlanCheckDeps {
  db: Db;
  files: RepoFileSource;
  checks: CheckPublisher;
  decode?: YamlDecoder;
}

export class FlagPlanCheckService {
  private readonly decode: YamlDecoder;

  constructor(private readonly deps: FlagPlanCheckDeps) {
    this.decode = deps.decode ?? decodeYaml;
  }

  /** One project's part of the report: the plan against it now, or the issues. */
  private async planProject(
    workspaceId: string,
    project: { id: string; name: string },
    parsed: FlagsFileParse,
  ): Promise<PlanCheckProject> {
    const { head, environments } = await readFlagsHead(this.deps.db, workspaceId, project.id);
    return {
      name: project.name,
      environments: environments.map(environment => ({
        key: environment.key,
        name: environment.name,
        changeGate: environment.changeGate,
      })),
      result: parsed.file === null ? { plan: null, issues: parsed.issues } : planFlagsFile(parsed.file, head),
    };
  }

  /**
   * Report on the pull request what merging it would do. Nothing is reported for a repo
   * linked to no project, a PR without the file, or a PR that leaves the file as it is on
   * the base (compared by content).
   */
  async checkPullRequest(pullRequest: FlagPlanPullRequest): Promise<void> {
    const projects = await new FlagFileSyncRepo(this.deps.db).linkedProjectsOfRepo(
      pullRequest.workspaceId,
      pullRequest.repoId,
    );
    if (projects.length === 0) {
      return;
    }
    const [head, base] = await Promise.all([
      this.deps.files.getFileAtCommit(pullRequest.ref, pullRequest.headSha, FLAGS_FILE_PATH),
      this.deps.files.getFileAtCommit(pullRequest.ref, pullRequest.baseSha, FLAGS_FILE_PATH),
    ]);
    if (head === null || head === base) {
      return;
    }
    const parsed = parseFlagsFile(head, this.decode);
    const planned = await Promise.all(
      projects.map(async project => await this.planProject(pullRequest.workspaceId, project, parsed)),
    );
    await this.deps.checks.publishCheck(
      pullRequest.ref,
      renderPlanCheck({ headSha: pullRequest.headSha, projects: planned }),
    );
  }
}
