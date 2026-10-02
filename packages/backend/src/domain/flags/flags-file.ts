// Flags-as-code, the pure part (#145): `.mocco/flags.yml` → its desired state → the
// changes that bring the project there. Parsing checks the file on its own; planning
// checks it against the project (environments that exist, flag types and variants that
// can't change from the file, segments the rules name) and answers either a whole plan
// or the issues, never a partial plan. A kill is not part of the desired state, so a
// plan never kills or restores a flag.
import { FlagManagers } from '@mocco/common/flags';
import { offVariantOfFileFlag, variantsOfFileFlag, flagsFileSchema } from '@mocco/common/flags-file';

import { canonicalize } from '@backend/domain/audit/chain';
import { applyOps } from '@backend/domain/flags/apply-ops';
import { InvalidChangeError } from '@backend/domain/flags/errors';
import { MoccoConfigYamlError } from '@backend/domain/pipeline/errors';

import type { EnvironmentState, FlagConfigState } from '@backend/domain/flags/apply-ops';
import type { YamlDecoder } from '@backend/domain/pipeline/yaml/decode';
import type {
  ChangeOp,
  Clause,
  FlagLifecycle,
  FlagManager,
  FlagType,
  RolloutEntry,
  Rule,
  Serve,
} from '@mocco/common/flags';
import type { FlagsFile, FlagsFileFlag } from '@mocco/common/flags-file';

export interface FlagsFileIssue {
  /** Where in the file, dotted (`flags.checkout.targets.production.default`). */
  path: string;
  message: string;
  line?: number;
}

/** The file, or null with the issues that refused it. */
export interface FlagsFileParse {
  file: FlagsFile | null;
  issues: FlagsFileIssue[];
}

/** Decode and validate `.mocco/flags.yml`. */
export function parseFlagsFile(source: string, decode: YamlDecoder): FlagsFileParse {
  let value: unknown;
  try {
    value = decode(source);
  } catch (error) {
    if (error instanceof MoccoConfigYamlError) {
      return {
        file: null,
        issues: [{ path: '', message: error.message, ...(error.line !== undefined && { line: error.line }) }],
      };
    }
    throw error;
  }
  const parsed = flagsFileSchema.safeParse(value);
  return parsed.success
    ? { file: parsed.data, issues: [] }
    : {
        file: null,
        issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
      };
}

/** A flag's project-level definition as it is now. */
export interface HeadFlag {
  type: FlagType;
  variants: Readonly<Record<string, unknown>>;
  description: string | null;
  lifecycle: FlagLifecycle;
  clientVisible: boolean;
  managedBy: FlagManager;
}

/** The project as it is now: its flags, and each environment's state by environment key. */
export interface FlagsHead {
  flags: ReadonlyMap<string, HeadFlag>;
  environments: ReadonlyMap<string, EnvironmentState>;
}

/** A flag the file adds to the project (it starts off in every environment). */
export interface FlagCreation {
  key: string;
  type: FlagType;
  variants: Record<string, unknown>;
  offVariant: string;
  description: string | null;
  lifecycle: FlagLifecycle;
  clientVisible: boolean;
}

/** A change to an existing flag's definition: only the fields that differ, and new variants. */
export interface FlagDefinitionUpdate {
  key: string;
  // eslint-disable-next-line sonarjs/no-redundant-optional -- absent: unchanged; null: the description is removed
  description?: string | null;
  lifecycle?: FlagLifecycle;
  clientVisible?: boolean;
  addedVariants?: Record<string, unknown>;
}

export interface FlagsSyncPlan {
  creations: FlagCreation[];
  definitionUpdates: FlagDefinitionUpdate[];
  /** Flags the console managed until now; the file takes them over. */
  adopted: string[];
  /** Repo-managed flags the file no longer lists: turned off everywhere and handed back to the console. */
  released: string[];
  /** One changeset per environment whose state changes, in environment key order. */
  changes: { environmentKey: string; ops: ChangeOp[] }[];
}

/** A whole plan, or null with every issue found. */
export interface FlagsSyncPlanResult {
  plan: FlagsSyncPlan | null;
  issues: FlagsFileIssue[];
}

const clauseOf = (clause: NonNullable<FlagsFileFlag['targets'][string]['rules'][number]['when']>): Clause[] =>
  (Array.isArray(clause) ? clause : [clause]).map(one =>
    'segment' in one
      ? { segment: one.segment, negate: one.negate ?? false }
      : { attribute: one.attribute, op: one.op, values: one.values },
  );

const rolloutOf = (weights: Readonly<Record<string, number>>): RolloutEntry[] =>
  Object.entries(weights).map(([variant, weight]) => ({ variant, weight }));

const serveOf = (serve: FlagsFileFlag['targets'][string]['rules'][number]['serve']): Serve =>
  typeof serve === 'string' ? { variant: serve } : { rollout: rolloutOf(serve.rollout) };

/** A flag added by the file, before any change: off, serving its off variant. */
const freshConfig = (offVariant: string): FlagConfigState => ({
  enabled: false,
  killed: false,
  defaultVariant: offVariant,
  offVariant,
  rules: [],
  rollout: null,
});

/** The ops that turn `current` into `desired` (never kill or restore). */
const isSame = (a: unknown, b: unknown): boolean => canonicalize(a) === canonicalize(b);

function opsFor(flagKey: string, current: FlagConfigState, desired: Omit<FlagConfigState, 'killed'>): ChangeOp[] {
  const ops: ChangeOp[] = [];
  if (current.offVariant !== desired.offVariant) {
    ops.push({ op: 'set_off_variant', flagKey, variant: desired.offVariant });
  }
  if (current.defaultVariant !== desired.defaultVariant) {
    ops.push({ op: 'set_default_variant', flagKey, variant: desired.defaultVariant });
  }
  if (!isSame(current.rules, desired.rules)) {
    ops.push({ op: 'set_rules', flagKey, rules: desired.rules });
  }
  if (!isSame(current.rollout, desired.rollout)) {
    ops.push({ op: 'set_rollout', flagKey, rollout: desired.rollout });
  }
  if (current.enabled !== desired.enabled) {
    ops.push({ op: 'set_enabled', flagKey, enabled: desired.enabled });
  }
  return ops;
}

type DefinitionPlan =
  | { kind: 'create'; creation: FlagCreation }
  | { kind: 'issue'; issue: FlagsFileIssue }
  | { kind: 'existing'; key: string; isAdopted: boolean; update: FlagDefinitionUpdate | null };

/** One file flag against its definition in the project. */
// eslint-disable-next-line sonarjs/function-return-type -- every branch is a DefinitionPlan, told apart by `kind`
function planDefinition(key: string, flag: FlagsFileFlag, existing: HeadFlag | undefined): DefinitionPlan {
  const variants = variantsOfFileFlag(flag);
  const description = flag.description ?? null;
  if (existing === undefined) {
    return {
      kind: 'create',
      creation: {
        key,
        type: flag.type,
        variants,
        offVariant: offVariantOfFileFlag(flag),
        description,
        lifecycle: flag.lifecycle,
        clientVisible: flag.client_visible,
      },
    };
  }
  if (existing.type !== flag.type) {
    return {
      kind: 'issue',
      issue: { path: `flags.${key}.type`, message: `"${key}" is a ${existing.type} flag; a flag's type can't change` },
    };
  }
  const changedVariant = Object.keys(existing.variants).find(
    name => !Object.hasOwn(variants, name) || !isSame(variants[name], existing.variants[name]),
  );
  if (changedVariant !== undefined) {
    return {
      kind: 'issue',
      issue: {
        path: `flags.${key}.variants.${changedVariant}`,
        message: `Variant "${changedVariant}" of "${key}" is missing or changed; variants can only be added`,
      },
    };
  }
  const added = Object.fromEntries(
    Object.entries(variants).filter(([name]) => !Object.hasOwn(existing.variants, name)),
  );
  const update: FlagDefinitionUpdate = {
    key,
    ...(existing.description !== description && { description }),
    ...(existing.lifecycle !== flag.lifecycle && { lifecycle: flag.lifecycle }),
    ...(existing.clientVisible !== flag.client_visible && { clientVisible: flag.client_visible }),
    ...(Object.keys(added).length > 0 && { addedVariants: added }),
  };
  return {
    kind: 'existing',
    key,
    isAdopted: existing.managedBy === FlagManagers.ui,
    update: Object.keys(update).length > 1 ? update : null,
  };
}

/** The desired config of `flag` in an environment it lists (or off where it doesn't). */
function desiredConfig(
  flag: FlagsFileFlag,
  environmentKey: string,
  current: FlagConfigState,
): Omit<FlagConfigState, 'killed'> {
  const target = flag.targets[environmentKey];
  if (target === undefined) {
    return { ...current, enabled: false };
  }
  return {
    enabled: target.enabled,
    defaultVariant: target.default,
    offVariant: offVariantOfFileFlag(flag),
    rules: target.rules.map((rule): Rule => ({ clauses: clauseOf(rule.when), serve: serveOf(rule.serve) })),
    rollout: target.rollout === undefined ? null : rolloutOf(target.rollout),
  };
}

/** One environment's changeset: the file's flags brought to their desired config, released flags turned off. */
function planEnvironment(
  file: FlagsFile,
  state: EnvironmentState,
  environmentKey: string,
  definitions: {
    creations: readonly FlagCreation[];
    updates: readonly FlagDefinitionUpdate[];
    released: readonly string[];
  },
): { ops: ChangeOp[]; issue: FlagsFileIssue | null } {
  // New flags join every environment off; plan their changes on top of that.
  const configs = new Map([
    ...state.configs,
    ...definitions.creations.map(creation => [creation.key, freshConfig(creation.offVariant)] as const),
  ]);
  const variants = new Map([
    ...state.variants,
    ...definitions.creations.map(creation => [creation.key, Object.keys(creation.variants)] as const),
    ...definitions.updates.map(
      update =>
        [update.key, [...(state.variants.get(update.key) ?? []), ...Object.keys(update.addedVariants ?? {})]] as const,
    ),
  ]);
  const ops: ChangeOp[] = [
    ...Object.entries(file.flags).flatMap(([key, flag]) => {
      const current = configs.get(key);
      return current === undefined ? [] : opsFor(key, current, desiredConfig(flag, environmentKey, current));
    }),
    ...definitions.released
      .filter(key => configs.get(key)?.enabled === true)
      .map((key): ChangeOp => ({ op: 'set_enabled', flagKey: key, enabled: false })),
  ];
  if (ops.length === 0) {
    return { ops, issue: null };
  }
  try {
    applyOps({ configs, segments: state.segments, variants }, ops);
    return { ops, issue: null };
  } catch (error) {
    if (!(error instanceof InvalidChangeError)) {
      throw error;
    }
    return { ops: [], issue: { path: `environments.${environmentKey}`, message: error.message } };
  }
}

/**
 * Plan bringing `head` to what `file` declares. A whole plan, or every issue found (an
 * environment the file names that doesn't exist, a type or variant change, a rule naming
 * a missing segment) and no plan.
 */
export function planFlagsFile(file: FlagsFile, head: FlagsHead): FlagsSyncPlanResult {
  const missingEnvironments = Object.entries(file.flags).flatMap(([key, flag]) =>
    Object.keys(flag.targets)
      .filter(environmentKey => !head.environments.has(environmentKey))
      .map(environmentKey => ({
        path: `flags.${key}.targets.${environmentKey}`,
        message: `There is no environment "${environmentKey}" in this project`,
      })),
  );
  const definitions = Object.entries(file.flags).map(([key, flag]) => planDefinition(key, flag, head.flags.get(key)));
  const creations = definitions.flatMap(entry => (entry.kind === 'create' ? [entry.creation] : []));
  const updates = definitions.flatMap(entry =>
    entry.kind === 'existing' && entry.update !== null ? [entry.update] : [],
  );
  const adopted = definitions.flatMap(entry => (entry.kind === 'existing' && entry.isAdopted ? [entry.key] : []));
  const released = [...head.flags]
    .filter(([key, flag]) => flag.managedBy === FlagManagers.repo && !Object.hasOwn(file.flags, key))
    .map(([key]) => key);
  const environments = [...head.environments]
    .toSorted((a, b) => a[0].localeCompare(b[0]))
    .map(([environmentKey, state]) => ({
      environmentKey,
      ...planEnvironment(file, state, environmentKey, { creations, updates, released }),
    }));
  const issues = [
    ...missingEnvironments,
    ...definitions.flatMap(entry => (entry.kind === 'issue' ? [entry.issue] : [])),
    ...environments.flatMap(entry => (entry.issue === null ? [] : [entry.issue])),
  ];
  if (issues.length > 0) {
    return { plan: null, issues };
  }
  const changes = environments
    .filter(entry => entry.ops.length > 0)
    .map(entry => ({ environmentKey: entry.environmentKey, ops: entry.ops }));
  return { plan: { creations, definitionUpdates: updates, adopted, released, changes }, issues: [] };
}
