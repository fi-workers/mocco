// Flags-as-code on a push (#145, feature flags design §3). A push to a repo's default
// branch reads `.mocco/flags.yml` at the pushed commit, for every project the repo is
// linked to, and brings each project to what the file declares: it creates and updates
// flag definitions, then makes one changeset per environment that changes. An
// unprotected environment applies at once; a protected one waits for its gate, and a
// newer push replaces what the last one left pending. A refused file changes nothing.
// Every sync is recorded with how it ended, so a refused file shows in the console.
import { AuditActions } from '@mocco/common/audit';
import { ChangeOutcomes, FlagFileSyncStates, FlagManagers, ChangesetSources } from '@mocco/common/flags';
import { FLAGS_FILE_PATH } from '@mocco/common/flags-file';

import { parseFlagsFile, planFlagsFile } from '@backend/domain/flags/flags-file';
import { readFlagsHead } from '@backend/domain/flags/flags-head';
import { FlagFileSyncRepo } from '@backend/domain/flags/repos/flag-file-sync.repo';
import { FlagRepo } from '@backend/domain/flags/repos/flag.repo';
import { decodeYaml } from '@backend/domain/pipeline/yaml/decode';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { FlagGovernanceService } from '@backend/domain/flags/FlagGovernanceService';
import type { FlagsSyncPlan } from '@backend/domain/flags/flags-file';
import type { FlagService } from '@backend/domain/flags/FlagService';
import type { FlagEnvironmentRow } from '@backend/domain/flags/repos/flag-environment.repo';
import type { FlagFileSyncRow } from '@backend/domain/flags/repos/flag-file-sync.repo';
import type { RepoFileSource } from '@backend/domain/integration/ports';
import type { YamlDecoder } from '@backend/domain/pipeline/yaml/decode';
import type { Db } from '@backend/infra/db/types';
import type { FlagFileSyncState } from '@mocco/common/flags';

/** A push to a repo's default branch, as the integration domain hands it over. */
export interface FlagFilePush {
  workspaceId: string;
  repoId: string;
  ref: { externalAccountId: string; owner: string; name: string };
  commitSha: string;
  /** The GitHub account that pushed (or merged). */
  senderGithubId: string | null;
  /** The head commit's author email (a git claim, not verified). */
  authorEmail: string | null;
}

export interface FlagFileSyncDeps {
  db: Db;
  audit: AuditService;
  flags: FlagService;
  governance?: FlagGovernanceService;
  files: RepoFileSource;
  decode?: YamlDecoder;
}

const isEmpty = (plan: FlagsSyncPlan): boolean =>
  plan.creations.length === 0 &&
  plan.definitionUpdates.length === 0 &&
  plan.adopted.length === 0 &&
  plan.released.length === 0 &&
  plan.changes.length === 0;

/** Run `work` on each item one after another (one connection, ordered effects). */
async function inOrder<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  return await items.reduce<Promise<R[]>>(
    async (previous, item) => [...(await previous), await work(item)],
    Promise.resolve([]),
  );
}

export class FlagFileSyncService {
  private readonly decode: YamlDecoder;

  constructor(private readonly deps: FlagFileSyncDeps) {
    this.decode = deps.decode ?? decodeYaml;
  }

  /**
   * Who proposes the push's changesets, and so can't approve them (`prevent_self`): the
   * workspace member signed in with the GitHub account that pushed (or merged), and the
   * member whose verified email wrote the head commit. The pusher is the proposer when
   * known, else the author; the other one, when it is someone else, is a co-proposer.
   */
  private async proposersOf(push: FlagFilePush): Promise<{ proposer: string | null; coProposers: string[] }> {
    const repo = new FlagFileSyncRepo(this.deps.db);
    const [pusher, author] = await Promise.all([
      push.senderGithubId === null ? undefined : repo.memberByGithubAccount(push.workspaceId, push.senderGithubId),
      push.authorEmail === null ? undefined : repo.memberByVerifiedEmail(push.workspaceId, push.authorEmail),
    ]);
    const proposer = pusher ?? author ?? null;
    return { proposer, coProposers: author !== undefined && author !== proposer ? [author] : [] };
  }

  private async record(
    workspaceId: string,
    projectId: string,
    push: FlagFilePush,
    proposerUserId: string | null,
    state: FlagFileSyncState,
    issues: FlagFileSyncRow['issues'],
  ) {
    const row = await new FlagFileSyncRepo(this.deps.db).insert({
      workspaceId,
      projectId,
      repoId: push.repoId,
      commitSha: push.commitSha,
      state,
      issues,
    });
    await this.deps.audit.record(workspaceId, {
      actorUserId: proposerUserId,
      action: AuditActions.flagFileSynced,
      subjectType: 'project',
      subjectId: projectId,
      payload: { commitSha: push.commitSha, state, issues: issues.length },
    });
    return row;
  }

  /** Write the plan's definition changes: new flags, updates, and who manages what. */
  private async writeDefinitions(
    workspaceId: string,
    projectId: string,
    plan: FlagsSyncPlan,
    proposerUserId: string | null,
  ) {
    await inOrder(plan.creations, async creation => {
      await this.deps.flags.createFlag(
        workspaceId,
        projectId,
        proposerUserId,
        {
          key: creation.key,
          type: creation.type,
          variants: creation.variants,
          defaultVariant: creation.offVariant,
          offVariant: creation.offVariant,
          description: creation.description,
          lifecycle: creation.lifecycle,
        },
        { managedBy: FlagManagers.repo, clientVisible: creation.clientVisible, source: ChangesetSources.repo },
      );
    });
    const flags = new FlagRepo(this.deps.db);
    const listed = await flags.listByProject(workspaceId, projectId);
    const current = new Map(listed.map(flag => [flag.key, flag]));
    const edits = [
      ...plan.definitionUpdates.map(update => ({
        key: update.key,
        values: {
          ...(update.description !== undefined && { description: update.description }),
          ...(update.lifecycle !== undefined && { lifecycle: update.lifecycle }),
          ...(update.clientVisible !== undefined && { clientVisible: update.clientVisible }),
          ...(update.addedVariants !== undefined && {
            variants: { ...current.get(update.key)?.variants, ...update.addedVariants },
          }),
          managedBy: FlagManagers.repo,
        },
      })),
      ...plan.adopted
        .filter(key => plan.definitionUpdates.every(update => update.key !== key))
        .map(key => ({ key, values: { managedBy: FlagManagers.repo } })),
      ...plan.released.map(key => ({ key, values: { managedBy: FlagManagers.ui } })),
    ];
    await inOrder(edits, async edit => {
      const updated = await flags.updateDefinition(workspaceId, projectId, edit.key, edit.values);
      if (updated !== undefined) {
        await this.deps.audit.record(workspaceId, {
          actorUserId: proposerUserId,
          action: AuditActions.flagDefinitionChanged,
          subjectType: 'flag',
          subjectId: updated.id,
          payload: { key: edit.key, ...edit.values },
        });
      }
    });
  }

  /** Bring one project to what `source` declares, and record how it ended. */
  async syncProject(
    workspaceId: string,
    projectId: string,
    push: FlagFilePush,
    source: string,
    proposers: { proposer: string | null; coProposers: string[] },
  ): Promise<FlagFileSyncRow> {
    const proposerUserId = proposers.proposer;
    const parsed = parseFlagsFile(source, this.decode);
    if (parsed.file === null) {
      return await this.record(workspaceId, projectId, push, proposerUserId, FlagFileSyncStates.invalid, parsed.issues);
    }
    const { head, environments } = await readFlagsHead(this.deps.db, workspaceId, projectId);
    const planned = planFlagsFile(parsed.file, head);
    if (planned.plan === null) {
      return await this.record(
        workspaceId,
        projectId,
        push,
        proposerUserId,
        FlagFileSyncStates.invalid,
        planned.issues,
      );
    }
    const { plan } = planned;
    const environmentByKey = new Map(environments.map(environment => [environment.key, environment]));
    // What the repo's last push left pending where this one changes nothing is stale now.
    const unchanged = environments.filter(
      environment =>
        environment.changeGate !== null && plan.changes.every(change => change.environmentKey !== environment.key),
    );
    await inOrder(unchanged, async environment => {
      await this.deps.governance?.supersedeRepoPending(environment, push.repoId, proposerUserId);
    });
    if (isEmpty(plan)) {
      return await this.record(workspaceId, projectId, push, proposerUserId, FlagFileSyncStates.unchanged, []);
    }
    await this.writeDefinitions(workspaceId, projectId, plan, proposerUserId);
    const outcomes = await inOrder(plan.changes, async change => {
      const environment = environmentByKey.get(change.environmentKey) as FlagEnvironmentRow;
      const { outcome } = await this.deps.flags.applyRepoChangeset(workspaceId, projectId, {
        environmentId: environment.id,
        ops: change.ops,
        proposerUserId,
        coProposerUserIds: proposers.coProposers,
        repoId: push.repoId,
        commitSha: push.commitSha,
        reason: `${FLAGS_FILE_PATH} at ${push.commitSha.slice(0, 7)}`,
      });
      return outcome;
    });
    const state = outcomes.includes(ChangeOutcomes.pendingApproval)
      ? FlagFileSyncStates.pending
      : FlagFileSyncStates.applied;
    return await this.record(workspaceId, projectId, push, proposerUserId, state, []);
  }

  /**
   * Sync every project the pushed repo is linked to. A repo without the file is left
   * alone. Each project is isolated: one failing doesn't stop the others.
   */
  async syncPush(push: FlagFilePush): Promise<void> {
    const projectIds = await new FlagFileSyncRepo(this.deps.db).projectsOfRepo(push.workspaceId, push.repoId);
    if (projectIds.length === 0) {
      return;
    }
    const source = await this.deps.files.getFileAtCommit(push.ref, push.commitSha, FLAGS_FILE_PATH);
    if (source === null) {
      return;
    }
    const proposers = await this.proposersOf(push);
    await inOrder(projectIds, async projectId => {
      try {
        await this.syncProject(push.workspaceId, projectId, push, source, proposers);
      } catch (error) {
        console.error(`[flags] .mocco/flags.yml sync failed for project ${projectId} at ${push.commitSha}`, error);
      }
    });
  }
}
