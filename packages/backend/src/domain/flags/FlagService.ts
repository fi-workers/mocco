import { AuditActions } from '@mocco/common/audit';
import { ChangesetSources, FlagTypes } from '@mocco/common/flags';
import { resolveFlag } from '@mocco/flags-core';

import {
  FlagEnvironmentNotFoundError,
  FlagKeyTakenError,
  ProtectedEnvironmentError,
} from '@backend/domain/flags/errors';
import { FlagChangesetRepo } from '@backend/domain/flags/repos/flag-changeset.repo';
import { FlagConfigRepo } from '@backend/domain/flags/repos/flag-config.repo';
import { FlagEnvironmentRepo } from '@backend/domain/flags/repos/flag-environment.repo';
import { FlagRulesetSnapshotRepo } from '@backend/domain/flags/repos/flag-ruleset-snapshot.repo';
import { FlagSegmentRepo } from '@backend/domain/flags/repos/flag-segment.repo';
import { FlagRepo } from '@backend/domain/flags/repos/flag.repo';
import { RulesetPublisher } from '@backend/domain/flags/RulesetPublisher';
import { UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { FlagChangesetRow } from '@backend/domain/flags/repos/flag-changeset.repo';
import type { Db } from '@backend/infra/db/types';
import type { BooleanFlagCreateInput, ChangeOp, FlagCreateInput } from '@mocco/common/flags';
import type { EvaluationContext, Ruleset } from '@mocco/flags-core';

export interface FlagServiceDeps {
  db: Db;
  audit: AuditService;
  publisher?: RulesetPublisher;
}

/** How many changesets an environment's history returns. */
const HISTORY_LIMIT = 50;

/** Map a key collision to the domain error; re-throw anything else. */
const rethrowKeyTaken = (error: unknown, kind: 'environment' | 'flag', key: string): never => {
  if (error instanceof UniqueConstraintError) {
    throw new FlagKeyTakenError(kind, key, { cause: error });
  }
  throw error;
};

/** The variants a flag starts with in a new environment: a boolean serves `on` once
 * enabled and `off` when killed; any other type serves its first variant for both. */
function initialVariants(variants: Record<string, unknown>): { defaultVariant: string; offVariant: string } {
  if ('on' in variants && 'off' in variants) {
    return { defaultVariant: 'on', offVariant: 'off' };
  }
  const [first = 'off'] = Object.keys(variants);
  return { defaultVariant: first, offVariant: first };
}

/**
 * Feature flags of a project (#137): environments, flag definitions and their
 * per-environment configs. Every config change is a changeset applied by the
 * `RulesetPublisher` and audited with its diff. A new flag is added disabled to every
 * environment at once (a disabled flag serves the caller's code default, which is what
 * an unknown flag serves), and a new environment starts with every flag disabled.
 */
export class FlagService {
  private readonly publisher: RulesetPublisher;

  constructor(private readonly deps: FlagServiceDeps) {
    this.publisher = deps.publisher ?? new RulesetPublisher();
  }

  private async auditApplied(workspaceId: string, actorUserId: string | null, changeset: FlagChangesetRow) {
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.flagChangesetApplied,
      subjectType: 'flag_environment',
      subjectId: changeset.environmentId,
      payload: {
        changesetId: changeset.id,
        version: changeset.appliedVersion,
        source: changeset.source,
        contentHash: changeset.contentHash,
        diff: changeset.diff,
      },
    });
  }

  /** Run `work` in a transaction, mapping a key collision to `FlagKeyTakenError`. */
  private async inTransaction<T>(kind: 'environment' | 'flag', key: string, work: (tx: Db) => Promise<T>) {
    try {
      return await this.deps.db.transaction(work);
    } catch (error) {
      return rethrowKeyTaken(error, kind, key);
    }
  }

  private async requireEnvironment(workspaceId: string, projectId: string, environmentId: string) {
    const environment = await new FlagEnvironmentRepo(this.deps.db).find(workspaceId, projectId, environmentId);
    if (environment === undefined) {
      throw new FlagEnvironmentNotFoundError(environmentId);
    }
    return environment;
  }

  async listEnvironments(workspaceId: string, projectId: string) {
    return await new FlagEnvironmentRepo(this.deps.db).listByProject(workspaceId, projectId);
  }

  /** Create an environment with every existing flag in it, disabled. */
  async createEnvironment(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    input: { key: string; name: string },
  ) {
    const { environment, changeset } = await this.inTransaction('environment', input.key, async tx => {
      const created = await new FlagEnvironmentRepo(tx).insert({
        workspaceId,
        projectId,
        ...input,
        createdByUserId: actorUserId,
      });
      await this.publisher.publishInitial(tx, created);
      const flags = await new FlagRepo(tx).listByProject(workspaceId, projectId);
      if (flags.length === 0) {
        return { environment: created, changeset: undefined };
      }
      const ops: ChangeOp[] = flags.map(flag => ({
        op: 'add_flag',
        flagKey: flag.key,
        ...initialVariants(flag.variants),
      }));
      return await this.publisher.apply(tx, workspaceId, {
        environmentId: created.id,
        ops,
        source: ChangesetSources.ui,
        actorUserId,
        reason: null,
      });
    });
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.flagEnvironmentCreated,
      subjectType: 'flag_environment',
      subjectId: environment.id,
      payload: { key: environment.key, name: environment.name },
    });
    if (changeset !== undefined) {
      await this.auditApplied(workspaceId, actorUserId, changeset);
    }
    return environment;
  }

  /** The project's flags, each with its config in every environment. */
  async listFlags(workspaceId: string, projectId: string) {
    const [flags, configs] = await Promise.all([
      new FlagRepo(this.deps.db).listByProject(workspaceId, projectId),
      new FlagConfigRepo(this.deps.db).listForProject(workspaceId, projectId),
    ]);
    return flags.map(flag => ({
      ...flag,
      configs: configs
        .filter(({ config }) => config.flagId === flag.id)
        .map(({ config }) => ({
          flagKey: flag.key,
          environmentId: config.environmentId,
          enabled: config.enabled,
          killed: config.killed,
          defaultVariant: config.defaultVariant,
          offVariant: config.offVariant,
          rules: config.rules,
          rollout: config.rollout,
          version: config.version,
        })),
    }));
  }

  /** Create a boolean flag (`on` / `off`, serving `on` once enabled and `off` when killed). */
  async createBooleanFlag(workspaceId: string, projectId: string, actorUserId: string, input: BooleanFlagCreateInput) {
    return await this.createFlag(workspaceId, projectId, actorUserId, {
      ...input,
      type: FlagTypes.boolean,
      variants: { on: true, off: false },
      defaultVariant: 'on',
      offVariant: 'off',
    });
  }

  /** Create a flag of any type and add it, disabled, to every environment. One
   * transaction: the flag exists everywhere or nowhere. */
  async createFlag(workspaceId: string, projectId: string, actorUserId: string, input: FlagCreateInput) {
    const { flag, changesets } = await this.inTransaction('flag', input.key, async tx => {
      const created = await new FlagRepo(tx).insert({
        workspaceId,
        projectId,
        key: input.key,
        type: input.type,
        variants: input.variants,
        description: input.description,
        lifecycle: input.lifecycle,
        createdByUserId: actorUserId,
      });
      const environments = await new FlagEnvironmentRepo(tx).listByProjectInLockOrder(workspaceId, projectId);
      // One environment at a time: the transaction has one connection.
      const applied = await environments.reduce<Promise<FlagChangesetRow[]>>(async (previous, environment) => {
        const done = await previous;
        const { changeset } = await this.publisher.apply(tx, workspaceId, {
          environmentId: environment.id,
          ops: [
            {
              op: 'add_flag',
              flagKey: created.key,
              defaultVariant: input.defaultVariant,
              offVariant: input.offVariant,
            },
          ],
          source: ChangesetSources.ui,
          actorUserId,
          reason: null,
        });
        return [...done, changeset];
      }, Promise.resolve([]));
      return { flag: created, changesets: applied };
    });
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.flagCreated,
      subjectType: 'flag',
      subjectId: flag.id,
      payload: { key: flag.key, type: flag.type, lifecycle: flag.lifecycle, variants: Object.keys(flag.variants) },
    });
    await changesets.reduce(async (previous, changeset) => {
      await previous;
      await this.auditApplied(workspaceId, actorUserId, changeset);
    }, Promise.resolve());
    return flag;
  }

  /** The environment's segments. */
  async listSegments(workspaceId: string, projectId: string, environmentId: string) {
    await this.requireEnvironment(workspaceId, projectId, environmentId);
    const rows = await new FlagSegmentRepo(this.deps.db).listForEnvironment(workspaceId, environmentId);
    return rows.map(row => ({
      key: row.key,
      environmentId: row.environmentId,
      name: row.name,
      includedKeys: row.includedKeys,
      excludedKeys: row.excludedKeys,
      rules: row.rules,
      version: row.version,
    }));
  }

  /**
   * Evaluate the environment's flags for `context` — on the current ruleset, or on what
   * `ops` would make it (nothing is saved). The same evaluator as the SDKs (flags-core).
   */
  async preview(
    workspaceId: string,
    projectId: string,
    input: { environmentId: string; ops: ChangeOp[]; context: EvaluationContext },
  ) {
    const environment = await this.requireEnvironment(workspaceId, projectId, input.environmentId);
    const document = await this.publisher.preview(this.deps.db, environment, input.ops);
    const ruleset = document as unknown as Ruleset;
    return (
      Object.keys(document.flags)
        // eslint-disable-next-line sonarjs/null-dereference -- object keys are strings, never null
        .toSorted((a, b) => a.localeCompare(b))
        .map(flagKey => {
          const resolution = resolveFlag(ruleset, flagKey, input.context);
          return {
            flagKey,
            value: resolution.value ?? null,
            variant: resolution.variant ?? null,
            reason: resolution.reason,
            errorCode: resolution.errorCode ?? null,
          };
        })
    );
  }

  /**
   * Apply a changeset to an unprotected environment at once. `baseVersion` is the
   * version the caller saw: if the environment moved since, nothing is applied
   * (`ChangesetConflictError`).
   */
  async applyChangeset(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    input: { environmentId: string; baseVersion: number; ops: ChangeOp[]; reason: string | null },
  ) {
    const environment = await this.requireEnvironment(workspaceId, projectId, input.environmentId);
    if (environment.changeGate !== null) {
      throw new ProtectedEnvironmentError(environment.id);
    }
    const { changeset } = await this.deps.db.transaction(
      async tx => await this.publisher.apply(tx, workspaceId, { ...input, source: ChangesetSources.ui, actorUserId }),
    );
    await this.auditApplied(workspaceId, actorUserId, changeset);
    return changeset;
  }

  /** The environment's changesets, newest first. */
  async history(workspaceId: string, projectId: string, environmentId: string) {
    await this.requireEnvironment(workspaceId, projectId, environmentId);
    return await new FlagChangesetRepo(this.deps.db).listByEnvironment(workspaceId, environmentId, HISTORY_LIMIT);
  }

  /**
   * The ruleset a `flags:read` key serves (`GET /v1/flags/ruleset`). When the caller
   * already holds the current ETag only the head is read, so a 304 never loads the
   * document. Undefined if the environment is gone.
   */
  async servingRuleset(workspaceId: string, environmentId: string, heldEtags: readonly string[]) {
    const snapshots = new FlagRulesetSnapshotRepo(this.deps.db);
    const head = await snapshots.latestHead(workspaceId, environmentId);
    if (head === undefined || heldEtags.includes(head.etag)) {
      return head === undefined ? undefined : { ...head, document: undefined };
    }
    const snapshot = await snapshots.latest(workspaceId, environmentId);
    return snapshot === undefined
      ? undefined
      : { version: snapshot.version, etag: snapshot.etag, document: snapshot.document };
  }

  /** The environment's current compiled ruleset. */
  async ruleset(workspaceId: string, projectId: string, environmentId: string) {
    await this.requireEnvironment(workspaceId, projectId, environmentId);
    const snapshot = await new FlagRulesetSnapshotRepo(this.deps.db).latest(workspaceId, environmentId);
    if (snapshot === undefined) {
      throw new FlagEnvironmentNotFoundError(environmentId);
    }
    return snapshot;
  }
}
