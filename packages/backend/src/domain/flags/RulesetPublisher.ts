import { ChangesetStates } from '@mocco/common/flags';

import { applyOps, changesetContentHash } from '@backend/domain/flags/apply-ops';
import { compileRuleset, rulesetEtag } from '@backend/domain/flags/compile-ruleset';
import { ChangesetConflictError, FlagEnvironmentNotFoundError, InvalidChangeError } from '@backend/domain/flags/errors';
import { FlagChangesetRepo } from '@backend/domain/flags/repos/flag-changeset.repo';
import { FlagConfigRepo } from '@backend/domain/flags/repos/flag-config.repo';
import { FlagEnvironmentRepo } from '@backend/domain/flags/repos/flag-environment.repo';
import { FlagRulesetSnapshotRepo } from '@backend/domain/flags/repos/flag-ruleset-snapshot.repo';
import { FlagRepo } from '@backend/domain/flags/repos/flag.repo';

import type { FlagConfigState } from '@backend/domain/flags/apply-ops';
import type { CompiledFlagInput } from '@backend/domain/flags/compile-ruleset';
import type { FlagEnvironmentRow } from '@backend/domain/flags/repos/flag-environment.repo';
import type { Db } from '@backend/infra/db/types';
import type { ChangeOp, ChangesetSource } from '@mocco/common/flags';

export interface ApplyChangesetInput {
  environmentId: string;
  /** The version the ops were written against; undefined applies them to the current
   * one (system changes such as adding a new flag everywhere). */
  baseVersion?: number;
  ops: readonly ChangeOp[];
  source: ChangesetSource;
  actorUserId: string | null;
  reason: string | null;
}

const stateOf = (config: FlagConfigState): FlagConfigState => ({
  enabled: config.enabled,
  killed: config.killed,
  defaultVariant: config.defaultVariant,
  offVariant: config.offVariant,
});

/**
 * The only writer of flag configs. Applying a changeset is one transaction under the
 * environment's advisory lock: check the base version, apply the ops, write the
 * changed configs and the changeset, bump the environment's version and write the
 * compiled ruleset as an immutable snapshot. Two applies to one environment therefore
 * serialize, and a changeset written against an older version is refused
 * (`ChangesetConflictError`) instead of silently overwriting a newer change.
 * Auditing is the caller's, after commit (the audit chain has its own lock).
 */
export class RulesetPublisher {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** Write the empty version-0 snapshot of a new environment. */
  async publishInitial(tx: Db, environment: FlagEnvironmentRow) {
    const document = compileRuleset({ key: environment.key, version: 0 }, [], this.clock());
    await new FlagRulesetSnapshotRepo(tx).insert({
      environmentId: environment.id,
      version: 0,
      workspaceId: environment.workspaceId,
      etag: rulesetEtag(document),
      document: { ...document },
    });
  }

  /** Apply a changeset inside `tx` (which the caller commits). */
  async apply(tx: Db, workspaceId: string, input: ApplyChangesetInput) {
    const environment = await new FlagEnvironmentRepo(tx).lockForPublish(workspaceId, input.environmentId);
    if (environment === undefined) {
      throw new FlagEnvironmentNotFoundError(input.environmentId);
    }
    const baseVersion = input.baseVersion ?? environment.currentVersion;
    if (baseVersion !== environment.currentVersion) {
      throw new ChangesetConflictError(environment.id, baseVersion, environment.currentVersion);
    }

    const [flags, rows] = await Promise.all([
      new FlagRepo(tx).listByProject(workspaceId, environment.projectId),
      new FlagConfigRepo(tx).listForEnvironment(workspaceId, environment.id),
    ]);
    const configs = new Map(rows.map(({ config, flag }) => [flag.key, stateOf(config)]));
    const variants = new Map(flags.map(flag => [flag.key, Object.keys(flag.variants)]));
    const { changed, diff } = applyOps({ configs, variants }, input.ops);
    if (diff.length === 0) {
      throw new InvalidChangeError('This change does nothing');
    }

    const version = baseVersion + 1;
    const now = this.clock();
    const changeset = await new FlagChangesetRepo(tx).insert({
      workspaceId,
      environmentId: environment.id,
      state: ChangesetStates.applied,
      source: input.source,
      ops: [...input.ops],
      diff,
      contentHash: changesetContentHash(environment.id, baseVersion, input.ops),
      baseVersion,
      appliedVersion: version,
      proposedByUserId: input.actorUserId,
      reason: input.reason,
      resolvedAt: now,
    });
    const flagByKey = new Map(flags.map(flag => [flag.key, flag]));
    await new FlagConfigRepo(tx).upsert(
      [...changed].map(([flagKey, config]) => ({
        environmentId: environment.id,
        // applyOps only changes flags it found in `variants`, i.e. in `flags`.
        flagId: (flagByKey.get(flagKey) as (typeof flags)[number]).id,
        workspaceId,
        ...config,
        version,
      })),
    );

    const merged = new Map([...configs, ...changed]);
    const compiled: CompiledFlagInput[] = [...merged].map(([key, config]) => {
      const flag = flagByKey.get(key) as (typeof flags)[number];
      return { key, variants: flag.variants, lifecycle: flag.lifecycle, config };
    });
    const document = compileRuleset({ key: environment.key, version }, compiled, now);
    await new FlagRulesetSnapshotRepo(tx).insert({
      environmentId: environment.id,
      version,
      workspaceId,
      etag: rulesetEtag(document),
      document: { ...document },
      changesetId: changeset.id,
    });
    await new FlagEnvironmentRepo(tx).setVersion(workspaceId, environment.id, version);
    return { changeset, environment: { ...environment, currentVersion: version } };
  }
}
