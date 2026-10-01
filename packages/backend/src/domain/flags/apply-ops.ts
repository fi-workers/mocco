import { createHash } from 'node:crypto';

import { canonicalize } from '@backend/domain/audit/chain';
import { InvalidChangeError } from '@backend/domain/flags/errors';

import type { ChangeDiffEntry, ChangeOp } from '@mocco/common/flags';

/** What a changeset can change about a flag in one environment. */
export interface FlagConfigState {
  enabled: boolean;
  killed: boolean;
  defaultVariant: string;
  offVariant: string;
}

/** An environment's configs by flag key, plus each flag's variant names. */
export interface EnvironmentState {
  configs: ReadonlyMap<string, FlagConfigState>;
  variants: ReadonlyMap<string, readonly string[]>;
}

/** The fields of a config, in diff order. */
const FIELDS = ['enabled', 'killed', 'defaultVariant', 'offVariant'] as const;

const requireVariant = (state: EnvironmentState, flagKey: string, variant: string): void => {
  const variants = state.variants.get(flagKey);
  if (variants === undefined) {
    throw new InvalidChangeError(`Flag "${flagKey}" does not exist`);
  }
  if (!variants.includes(variant)) {
    throw new InvalidChangeError(`Flag "${flagKey}" has no variant "${variant}"`);
  }
};

const requireConfig = (configs: Map<string, FlagConfigState>, flagKey: string): FlagConfigState => {
  const config = configs.get(flagKey);
  if (config === undefined) {
    throw new InvalidChangeError(`Flag "${flagKey}" is not in this environment`);
  }
  return config;
};

/** Apply one op to `configs` (mutated and returned), or throw `InvalidChangeError`. */
function applyOp(
  state: EnvironmentState,
  configs: Map<string, FlagConfigState>,
  op: ChangeOp,
): Map<string, FlagConfigState> {
  if (op.op === 'add_flag') {
    if (configs.has(op.flagKey)) {
      throw new InvalidChangeError(`Flag "${op.flagKey}" is already in this environment`);
    }
    requireVariant(state, op.flagKey, op.defaultVariant);
    requireVariant(state, op.flagKey, op.offVariant);
    return configs.set(op.flagKey, {
      enabled: false,
      killed: false,
      defaultVariant: op.defaultVariant,
      offVariant: op.offVariant,
    });
  }
  const config = requireConfig(configs, op.flagKey);
  if (op.op === 'set_enabled') {
    return configs.set(op.flagKey, { ...config, enabled: op.enabled });
  }
  requireVariant(state, op.flagKey, op.variant);
  return configs.set(op.flagKey, { ...config, defaultVariant: op.variant });
}

/**
 * Apply `ops` in order to an environment's configs. Pure: returns the configs that
 * changed (keyed by flag) and the before/after of every changed field, or throws
 * `InvalidChangeError` for an op that doesn't apply (an unknown flag or variant, a
 * flag added twice). Ops that change nothing produce no diff.
 */
export function applyOps(
  state: EnvironmentState,
  ops: readonly ChangeOp[],
): { changed: Map<string, FlagConfigState>; diff: ChangeDiffEntry[] } {
  const configs = ops.reduce((next, op) => applyOp(state, next, op), new Map(state.configs));

  const changed = new Map<string, FlagConfigState>();
  const diff = [...new Set(ops.map(op => op.flagKey))].flatMap(flagKey => {
    const before = state.configs.get(flagKey);
    // Every op's flag is in `configs`: each op either adds it or requires it.
    const after = configs.get(flagKey) as FlagConfigState;
    const fields = FIELDS.filter(field => before?.[field] !== after[field]);
    if (fields.length > 0) {
      changed.set(flagKey, after);
    }
    return fields.map(field => ({ flagKey, field, before: before?.[field] ?? null, after: after[field] }));
  });
  return { changed, diff };
}

/** What an approval of a changeset pins: sha-256 over its environment, base and ops. */
export function changesetContentHash(environmentId: string, baseVersion: number, ops: readonly ChangeOp[]): string {
  return createHash('sha256').update(canonicalize({ environmentId, baseVersion, ops })).digest('hex');
}
