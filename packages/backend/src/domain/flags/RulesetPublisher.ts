import { ChangesetStates, FlagLimits } from '@mocco/common/flags';

import { applyOps, changesetContentHash } from '@backend/domain/flags/apply-ops';
import { compileRuleset, rulesetEtag } from '@backend/domain/flags/compile-ruleset';
import {
  ChangesetConflictError,
  FlagEnvironmentNotFoundError,
  InvalidChangeError,
  RulesetTooLargeError,
} from '@backend/domain/flags/errors';
import { FlagChangesetRepo } from '@backend/domain/flags/repos/flag-changeset.repo';
import { FlagConfigRepo } from '@backend/domain/flags/repos/flag-config.repo';
import { FlagEnvironmentRepo } from '@backend/domain/flags/repos/flag-environment.repo';
import { FlagRulesetSnapshotRepo } from '@backend/domain/flags/repos/flag-ruleset-snapshot.repo';
import { FlagSegmentRepo } from '@backend/domain/flags/repos/flag-segment.repo';
import { FlagRepo } from '@backend/domain/flags/repos/flag.repo';

import type { AppliedOps, FlagConfigState } from '@backend/domain/flags/apply-ops';
import type { CompiledFlagInput, FlagdDocument } from '@backend/domain/flags/compile-ruleset';
import type { FlagEnvironmentRow } from '@backend/domain/flags/repos/flag-environment.repo';
import type { FlagRow } from '@backend/domain/flags/repos/flag.repo';
import type { Db } from '@backend/infra/db/types';
import type { ChangeOp, ChangesetSource, SegmentDefinition } from '@mocco/common/flags';

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

/** An environment's head state as the publisher reads it. */
interface HeadState {
  flags: FlagRow[];
  configs: Map<string, FlagConfigState & { salt: string }>;
  segments: Map<string, SegmentDefinition>;
}

const configStateOf = (config: FlagConfigState): FlagConfigState => ({
  enabled: config.enabled,
  killed: config.killed,
  defaultVariant: config.defaultVariant,
  offVariant: config.offVariant,
  rules: config.rules,
  rollout: config.rollout,
});

async function readHead(db: Db, workspaceId: string, environment: FlagEnvironmentRow): Promise<HeadState> {
  const [flags, rows, segments] = await Promise.all([
    new FlagRepo(db).listByProject(workspaceId, environment.projectId),
    new FlagConfigRepo(db).listForEnvironment(workspaceId, environment.id),
    new FlagSegmentRepo(db).listForEnvironment(workspaceId, environment.id),
  ]);
  return {
    flags,
    configs: new Map(rows.map(({ config, flag }) => [flag.key, { ...configStateOf(config), salt: config.salt }])),
    segments: new Map(
      segments.map(segment => [
        segment.key,
        {
          name: segment.name,
          includedKeys: segment.includedKeys,
          excludedKeys: segment.excludedKeys,
          rules: segment.rules,
        },
      ]),
    ),
  };
}

/** The head with `applied` on top: what the next version holds. */
function nextState(head: HeadState, applied: AppliedOps) {
  const configs = new Map([...head.configs].map(([key, config]) => [key, configStateOf(config)]));
  applied.changed.forEach((config, key) => configs.set(key, config));
  const segments = new Map(head.segments);
  applied.changedSegments.forEach((segment, key) => segments.set(key, segment));
  applied.deletedSegments.forEach(key => segments.delete(key));
  return { configs, segments };
}

/** Compile the next version from the head and the applied ops, enforcing the size limit. */
function compileNext(
  environment: FlagEnvironmentRow,
  version: number,
  head: HeadState,
  applied: AppliedOps,
  now: Date,
): FlagdDocument {
  const { configs, segments } = nextState(head, applied);
  const flagByKey = new Map(head.flags.map(flag => [flag.key, flag]));
  const compiled: CompiledFlagInput[] = [...configs].flatMap(([key, config]) => {
    const flag = flagByKey.get(key);
    // A new flag's salt is generated on insert; until then its key stands in (preview only).
    const salt = head.configs.get(key)?.salt ?? key;
    return flag === undefined ? [] : [{ key, variants: flag.variants, lifecycle: flag.lifecycle, salt, config }];
  });
  const document = compileRuleset({ key: environment.key, version }, compiled, segments, now);
  const bytes = Buffer.byteLength(JSON.stringify(document));
  if (bytes > FlagLimits.rulesetBytes) {
    throw new RulesetTooLargeError(bytes, FlagLimits.rulesetBytes);
  }
  return document;
}

/**
 * The only writer of flag configs and segments. Applying a changeset is one transaction
 * under the environment's advisory lock: check the base version, apply the ops, write
 * what changed and the changeset, bump the environment's version and write the compiled
 * ruleset as an immutable snapshot. Two applies to one environment therefore serialize,
 * and a changeset written against an older version is refused (`ChangesetConflictError`)
 * instead of silently overwriting a newer change. A ruleset over `FlagLimits.rulesetBytes`
 * is refused (`RulesetTooLargeError`). Auditing is the caller's, after commit.
 */
export class RulesetPublisher {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** Write the empty version-0 snapshot of a new environment. */
  async publishInitial(tx: Db, environment: FlagEnvironmentRow) {
    const document = compileRuleset({ key: environment.key, version: 0 }, [], new Map(), this.clock());
    await new FlagRulesetSnapshotRepo(tx).insert({
      environmentId: environment.id,
      version: 0,
      workspaceId: environment.workspaceId,
      etag: rulesetEtag(document),
      document: { ...document },
    });
  }

  /** The document `ops` would produce on the current head, without writing anything. */
  async preview(db: Db, environment: FlagEnvironmentRow, ops: readonly ChangeOp[]): Promise<FlagdDocument> {
    const head = await readHead(db, environment.workspaceId, environment);
    const applied = applyOps(
      {
        configs: head.configs,
        segments: head.segments,
        variants: new Map(head.flags.map(flag => [flag.key, Object.keys(flag.variants)])),
      },
      ops,
    );
    return compileNext(environment, environment.currentVersion, head, applied, this.clock());
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

    const head = await readHead(tx, workspaceId, environment);
    const applied = applyOps(
      {
        configs: head.configs,
        segments: head.segments,
        variants: new Map(head.flags.map(flag => [flag.key, Object.keys(flag.variants)])),
      },
      input.ops,
    );
    if (applied.diff.length === 0) {
      throw new InvalidChangeError('This change does nothing');
    }

    const version = baseVersion + 1;
    const now = this.clock();
    const flagByKey = new Map(head.flags.map(flag => [flag.key, flag]));
    await new FlagConfigRepo(tx).upsert(
      [...applied.changed].map(([flagKey, config]) => ({
        environmentId: environment.id,
        // applyOps only changes flags it found in `variants`, i.e. in `flags`.
        flagId: (flagByKey.get(flagKey) as FlagRow).id,
        workspaceId,
        ...config,
        version,
      })),
    );
    const segments = new FlagSegmentRepo(tx);
    await segments.upsert(
      [...applied.changedSegments].map(([key, segment]) => ({
        environmentId: environment.id,
        key,
        workspaceId,
        ...segment,
        version,
      })),
    );
    await segments.delete(workspaceId, environment.id, [...applied.deletedSegments]);

    // Re-read: a new config's salt is generated by the insert above.
    const written = await readHead(tx, workspaceId, environment);
    const document = compileNext(
      environment,
      version,
      written,
      { changed: new Map(), changedSegments: new Map(), deletedSegments: new Set(), diff: [] },
      now,
    );
    const changeset = await new FlagChangesetRepo(tx).insert({
      workspaceId,
      environmentId: environment.id,
      state: ChangesetStates.applied,
      source: input.source,
      ops: [...input.ops],
      diff: applied.diff,
      contentHash: changesetContentHash(environment.id, baseVersion, input.ops),
      baseVersion,
      appliedVersion: version,
      proposedByUserId: input.actorUserId,
      reason: input.reason,
      resolvedAt: now,
    });
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
