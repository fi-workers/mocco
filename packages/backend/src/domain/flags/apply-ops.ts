import { createHash } from 'node:crypto';

import { canonicalize } from '@backend/domain/audit/chain';
import { InvalidChangeError } from '@backend/domain/flags/errors';

import type { ChangeDiffEntry, ChangeOp, RolloutEntry, Rule, SegmentDefinition, Serve } from '@mocco/common/flags';

/** What a changeset can change about a flag in one environment. */
export interface FlagConfigState {
  enabled: boolean;
  killed: boolean;
  defaultVariant: string;
  offVariant: string;
  rules: Rule[];
  rollout: RolloutEntry[] | null;
}

/** An environment's configs by flag key, its segments by key, and each flag's variant names. */
export interface EnvironmentState {
  configs: ReadonlyMap<string, FlagConfigState>;
  segments: ReadonlyMap<string, SegmentDefinition>;
  variants: ReadonlyMap<string, readonly string[]>;
}

/** What applying ops changed: configs and segments to write, segments to delete, the diff. */
export interface AppliedOps {
  changed: Map<string, FlagConfigState>;
  changedSegments: Map<string, SegmentDefinition>;
  deletedSegments: Set<string>;
  diff: ChangeDiffEntry[];
}

/** The fields of a config and of a segment, in diff order. */
const CONFIG_FIELDS = ['enabled', 'killed', 'defaultVariant', 'offVariant', 'rules', 'rollout'] as const;
const SEGMENT_FIELDS = ['name', 'includedKeys', 'excludedKeys', 'rules'] as const;

/** Throw unless the flag exists and has every one of `variants`. */
const requireVariants = (state: EnvironmentState, flagKey: string, variants: readonly string[]): void => {
  const known = state.variants.get(flagKey);
  if (known === undefined) {
    throw new InvalidChangeError(`Flag "${flagKey}" does not exist`);
  }
  const unknown = variants.find(variant => !known.includes(variant));
  if (unknown !== undefined) {
    throw new InvalidChangeError(`Flag "${flagKey}" has no variant "${unknown}"`);
  }
};

const requireConfig = (configs: Map<string, FlagConfigState>, flagKey: string): FlagConfigState => {
  const config = configs.get(flagKey);
  if (config === undefined) {
    throw new InvalidChangeError(`Flag "${flagKey}" is not in this environment`);
  }
  return config;
};

const servedVariants = (serve: Serve): string[] =>
  'variant' in serve ? [serve.variant] : serve.rollout.map(entry => entry.variant);

const segmentsOf = (rules: readonly Rule[]): string[] =>
  rules.flatMap(rule => rule.clauses.flatMap(clause => ('segment' in clause ? [clause.segment] : [])));

/** The working state while ops apply: mutable copies of the environment's maps. */
interface Working {
  state: EnvironmentState;
  configs: Map<string, FlagConfigState>;
  segments: Map<string, SegmentDefinition>;
}

function applyFlagOp(working: Working, op: Exclude<ChangeOp, { op: 'set_segment' | 'delete_segment' }>): void {
  const { state, configs, segments } = working;
  if (op.op === 'add_flag') {
    if (configs.has(op.flagKey)) {
      throw new InvalidChangeError(`Flag "${op.flagKey}" is already in this environment`);
    }
    requireVariants(state, op.flagKey, [op.defaultVariant, op.offVariant]);
    configs.set(op.flagKey, {
      enabled: false,
      killed: false,
      defaultVariant: op.defaultVariant,
      offVariant: op.offVariant,
      rules: [],
      rollout: null,
    });
    return;
  }
  const config = requireConfig(configs, op.flagKey);
  switch (op.op) {
    case 'set_enabled': {
      configs.set(op.flagKey, { ...config, enabled: op.enabled });
      return;
    }
    case 'set_default_variant': {
      requireVariants(state, op.flagKey, [op.variant]);
      configs.set(op.flagKey, { ...config, defaultVariant: op.variant });
      return;
    }
    case 'set_rules': {
      requireVariants(
        state,
        op.flagKey,
        op.rules.flatMap(rule => servedVariants(rule.serve)),
      );
      const missing = segmentsOf(op.rules).find(key => !segments.has(key));
      if (missing !== undefined) {
        throw new InvalidChangeError(`Segment "${missing}" is not in this environment`);
      }
      configs.set(op.flagKey, { ...config, rules: op.rules });
      return;
    }
    case 'set_rollout': {
      requireVariants(
        state,
        op.flagKey,
        (op.rollout ?? []).map(entry => entry.variant),
      );
      configs.set(op.flagKey, { ...config, rollout: op.rollout });
      return;
    }
    case 'kill': {
      configs.set(op.flagKey, { ...config, killed: true });
      return;
    }
    case 'restore': {
      configs.set(op.flagKey, { ...config, killed: false });
      return;
    }
    case 'set_off_variant': {
      requireVariants(state, op.flagKey, [op.variant]);
      configs.set(op.flagKey, { ...config, offVariant: op.variant });
      return;
    }
    default: {
      throw new InvalidChangeError('Unknown change');
    }
  }
}

function applyOp(working: Working, op: ChangeOp): void {
  if (op.op === 'set_segment') {
    working.segments.set(op.segmentKey, op.segment);
    return;
  }
  if (op.op === 'delete_segment') {
    if (!working.segments.has(op.segmentKey)) {
      throw new InvalidChangeError(`Segment "${op.segmentKey}" is not in this environment`);
    }
    const user = [...working.configs].find(([, config]) => segmentsOf(config.rules).includes(op.segmentKey));
    if (user !== undefined) {
      throw new InvalidChangeError(`Segment "${op.segmentKey}" is used by flag "${user[0]}"`);
    }
    working.segments.delete(op.segmentKey);
    return;
  }
  applyFlagOp(working, op);
}

const isSame = (a: unknown, b: unknown): boolean => canonicalize(a ?? null) === canonicalize(b ?? null);

/**
 * Apply `ops` in order to an environment's configs and segments. Pure: returns what
 * changed and the before/after of every changed field, or throws `InvalidChangeError`
 * for an op that doesn't apply (an unknown flag, variant or segment, a flag added twice,
 * deleting a segment a rule still uses). Ops that change nothing produce no diff.
 */
export function applyOps(state: EnvironmentState, ops: readonly ChangeOp[]): AppliedOps {
  const working = ops.reduce<Working>(
    (current, op) => {
      applyOp(current, op);
      return current;
    },
    { state, configs: new Map(state.configs), segments: new Map(state.segments) },
  );

  const changed = new Map<string, FlagConfigState>();
  const flagKeys = new Set(ops.flatMap(op => ('flagKey' in op ? [op.flagKey] : [])));
  const flagDiff = [...flagKeys].flatMap((key): ChangeDiffEntry[] => {
    const before = state.configs.get(key);
    // Every op's flag is in `configs`: each op either adds it or requires it.
    const after = working.configs.get(key) as FlagConfigState;
    const fields = CONFIG_FIELDS.filter(field => !isSame(before?.[field], after[field]));
    if (fields.length > 0) {
      changed.set(key, after);
    }
    return fields.map(field => ({ subject: 'flag', key, field, before: before?.[field] ?? null, after: after[field] }));
  });

  const changedSegments = new Map<string, SegmentDefinition>();
  const deletedSegments = new Set<string>();
  const segmentKeys = new Set(ops.flatMap(op => ('segmentKey' in op ? [op.segmentKey] : [])));
  const segmentDiff = [...segmentKeys].flatMap((key): ChangeDiffEntry[] => {
    const before = state.segments.get(key);
    const after = working.segments.get(key);
    if (after === undefined) {
      if (before === undefined) {
        return [];
      }
      deletedSegments.add(key);
      return [{ subject: 'segment', key, field: 'segment', before: before.name, after: null }];
    }
    const fields = SEGMENT_FIELDS.filter(field => !isSame(before?.[field], after[field]));
    if (fields.length > 0) {
      changedSegments.set(key, after);
    }
    return fields.map(field => ({
      subject: 'segment',
      key,
      field,
      before: before?.[field] ?? null,
      after: after[field],
    }));
  });

  return { changed, changedSegments, deletedSegments, diff: [...flagDiff, ...segmentDiff] };
}

/** What an approval of a changeset pins: sha-256 over its environment, base and ops. */
export function changesetContentHash(environmentId: string, baseVersion: number, ops: readonly ChangeOp[]): string {
  return createHash('sha256').update(canonicalize({ environmentId, baseVersion, ops })).digest('hex');
}
