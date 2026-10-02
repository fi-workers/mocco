import { createHash } from 'node:crypto';

import { BUCKETING_VERSION, ClauseOps, FLAGD_SCHEMA_URL } from '@mocco/common/flags';

import { canonicalize } from '@backend/domain/audit/chain';

import type { FlagConfigState } from '@backend/domain/flags/apply-ops';
import type {
  AttributeClause,
  Clause,
  FlagLifecycle,
  RolloutEntry,
  Rule,
  SegmentDefinition,
  Serve,
} from '@mocco/common/flags';

/** One flag of an environment, as the compiler needs it. */
export interface CompiledFlagInput {
  key: string;
  variants: Record<string, unknown>;
  lifecycle: FlagLifecycle;
  /** Mixed into percentage bucketing (`mocco-v1`). */
  salt: string;
  config: FlagConfigState;
}

/** A flagd flag-definition document (schema v0). */
export interface FlagdDocument {
  $schema: string;
  metadata: Record<string, string | number | boolean>;
  flags: Record<
    string,
    {
      state: 'ENABLED' | 'DISABLED';
      variants: Record<string, unknown>;
      defaultVariant: string;
      targeting: Record<string, unknown>;
      metadata: Record<string, string | number | boolean>;
    }
  >;
}

const TARGETING_KEY: unknown = { var: 'targetingKey' };

/** `{and: [...]}` for several parts, the part itself for one. */
const allOf = (parts: unknown[]): unknown => (parts.length === 1 ? parts[0] : { and: parts });
const anyOf = (parts: unknown[]): unknown => (parts.length === 1 ? parts[0] : { or: parts });

const SEMVER_OPERATORS: Partial<Record<AttributeClause['op'], string>> = {
  [ClauseOps.semverEq]: '=',
  [ClauseOps.semverLt]: '<',
  [ClauseOps.semverLte]: '<=',
  [ClauseOps.semverGt]: '>',
  [ClauseOps.semverGte]: '>=',
};
const COMPARISONS: Partial<Record<AttributeClause['op'], string>> = {
  [ClauseOps.lt]: '<',
  [ClauseOps.lte]: '<=',
  [ClauseOps.gt]: '>',
  [ClauseOps.gte]: '>=',
};

/** An attribute clause in the JsonLogic subset. A missing attribute never matches a comparison. */
export function compileAttributeClause(clause: AttributeClause): unknown {
  const attribute = { var: clause.attribute };
  const [first] = clause.values;
  const semver = SEMVER_OPERATORS[clause.op];
  if (semver !== undefined) {
    return { sem_ver: [attribute, semver, first] };
  }
  const comparison = COMPARISONS[clause.op];
  if (comparison !== undefined) {
    // JsonLogic compares null as 0, so require the attribute first. `!(x in [null])` is the
    // presence test JsonLogic engines agree on (json-logic-engine reads `0 != null` as false).
    return { and: [{ '!': { in: [attribute, [null]] } }, { [comparison]: [attribute, first] }] };
  }
  switch (clause.op) {
    case ClauseOps.in: {
      return { in: [attribute, clause.values] };
    }
    case ClauseOps.notIn: {
      return { '!': { in: [attribute, clause.values] } };
    }
    case ClauseOps.startsWith:
    case ClauseOps.endsWith: {
      return anyOf(clause.values.map(value => ({ [clause.op]: [attribute, value] })));
    }
    default: {
      throw new Error(`Unknown clause operator ${clause.op}`);
    }
  }
}

/** Membership of a segment: not excluded, and included or matching one of its rule groups. */
export function compileSegment(segment: SegmentDefinition): unknown {
  const ways: unknown[] = [
    ...(segment.includedKeys.length > 0 ? [{ in: [TARGETING_KEY, segment.includedKeys] }] : []),
    ...segment.rules.map(group => allOf(group.map(clause => compileAttributeClause(clause)))),
  ];
  if (ways.length === 0) {
    return false;
  }
  return segment.excludedKeys.length > 0
    ? { and: [{ '!': { in: [TARGETING_KEY, segment.excludedKeys] } }, anyOf(ways)] }
    : anyOf(ways);
}

function compileClause(clause: Clause, segments: ReadonlyMap<string, SegmentDefinition>): unknown {
  if (!('segment' in clause)) {
    return compileAttributeClause(clause);
  }
  const segment = segments.get(clause.segment);
  // applyOps refuses rules on unknown segments; an unknown one matches nobody.
  const member = segment === undefined ? false : compileSegment(segment);
  return clause.negate ? { '!': member } : member;
}

/**
 * A percentage rollout: flagd `fractional` bucketed on `salt + targetingKey` (`mocco-v1`).
 * Callers without a targeting key fall back to the default variant (null).
 */
function compileRollout(rollout: readonly RolloutEntry[], salt: string): unknown {
  return {
    if: [
      TARGETING_KEY,
      { fractional: [{ cat: [salt, TARGETING_KEY] }, ...rollout.map(entry => [entry.variant, entry.weight])] },
      null,
    ],
  };
}

const compileServe = (serve: Serve, salt: string): unknown =>
  'variant' in serve ? serve.variant : compileRollout(serve.rollout, salt);

/** A config's targeting: its rules in order, then the fallthrough rollout. `{}` when static. */
export function compileTargeting(
  config: Pick<FlagConfigState, 'rules' | 'rollout'>,
  salt: string,
  segments: ReadonlyMap<string, SegmentDefinition>,
): Record<string, unknown> {
  const branches = config.rules.flatMap((rule: Rule) => [
    allOf(rule.clauses.map(clause => compileClause(clause, segments))),
    compileServe(rule.serve, salt),
  ]);
  const fallthrough = config.rollout === null ? [] : [compileRollout(config.rollout, salt)];
  if (branches.length === 0) {
    return fallthrough.length === 0 ? {} : (fallthrough[0] as Record<string, unknown>);
  }
  return { if: [...branches, ...fallthrough] };
}

/**
 * Compile an environment's flags into the flagd document SDKs evaluate (ADR 0024).
 * flagd metadata values must be primitives, so Mocco's metadata is flat `mocco.*` keys.
 * A disabled flag is `state: DISABLED` (callers get their code default); a killed flag
 * stays ENABLED but serves its off variant with no targeting, so even a stale or
 * third-party flagd client serves the off variant. Segments are inlined into the rules
 * that use them, which is why the document is server-key-only.
 */
export function compileRuleset(
  environment: { key: string; version: number },
  flags: readonly CompiledFlagInput[],
  segments: ReadonlyMap<string, SegmentDefinition>,
  generatedAt: Date,
): FlagdDocument {
  const compiled: FlagdDocument['flags'] = Object.fromEntries(
    flags.map(({ key, variants, lifecycle, salt, config }) => [
      key,
      {
        state: config.enabled || config.killed ? 'ENABLED' : 'DISABLED',
        variants,
        defaultVariant: config.killed ? config.offVariant : config.defaultVariant,
        targeting: config.killed ? {} : compileTargeting(config, salt, segments),
        metadata: {
          'mocco.offVariant': config.offVariant,
          'mocco.killed': config.killed,
          'mocco.lifecycle': lifecycle,
        },
      },
    ]),
  );
  return {
    $schema: FLAGD_SCHEMA_URL,
    metadata: {
      'mocco.environment': environment.key,
      'mocco.version': environment.version,
      'mocco.generatedAt': generatedAt.toISOString(),
      'mocco.bucketing': BUCKETING_VERSION,
    },
    flags: compiled,
  };
}

/** A strong ETag of a document: its canonical sha-256, quoted. */
export function rulesetEtag(document: FlagdDocument): string {
  return `"${createHash('sha256').update(canonicalize(document)).digest('base64url')}"`;
}
