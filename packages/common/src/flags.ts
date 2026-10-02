import { z } from 'zod';

import { gateRequirementsSchema } from './governance';

/**
 * Feature flags (#101): constants and wire shapes shared by the backend and the console.
 * A flag is defined once per project (key, type, variants); each environment holds its
 * own config of it, changed only by changesets. An environment is a flag target (ADR
 * 0023): an evaluation scope with no built-in meaning, protected only by a change gate.
 */

/** A flag key (what code passes to the SDK). */
export const FLAG_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
/** An environment key: a lowercase slug. */
export const FLAG_ENVIRONMENT_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** A variant name. */
export const VARIANT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const FlagTypes = {
  boolean: 'boolean',
  string: 'string',
  number: 'number',
  json: 'json',
} as const;
export type FlagType = (typeof FlagTypes)[keyof typeof FlagTypes];

export const FlagLifecycles = { temporary: 'temporary', permanent: 'permanent' } as const;
export type FlagLifecycle = (typeof FlagLifecycles)[keyof typeof FlagLifecycles];

/** Who owns a flag's definition and rules: the console, or `.mocco/flags.yml` (#145).
 * A repo-managed flag is read-only in the console, except its kill switch. */
export const FlagManagers = { ui: 'ui', repo: 'repo' } as const;
export type FlagManager = (typeof FlagManagers)[keyof typeof FlagManagers];

/** Where a changeset came from. */
export const ChangesetSources = { ui: 'ui', repo: 'repo', api: 'api', kill: 'kill' } as const;
export type ChangesetSource = (typeof ChangesetSources)[keyof typeof ChangesetSources];

export const ChangesetStates = {
  pending: 'pending',
  applied: 'applied',
  rejected: 'rejected',
  conflicted: 'conflicted',
  superseded: 'superseded',
  withdrawn: 'withdrawn',
  expired: 'expired',
} as const;
export type ChangesetState = (typeof ChangesetStates)[keyof typeof ChangesetStates];

/** The `subject_type`s of flag approval requests (ADR 0020). */
export const FlagApprovalSubjects = {
  /** A changeset to a protected environment, pinned by its content hash. */
  changeset: 'flags.changeset',
  /** Changing (or removing) a protected environment's change gate. */
  changeGate: 'flags.change_gate',
  /** The post-hoc review of a kill on a protected environment. */
  kill: 'flags.kill',
} as const;

/** How a proposed change ended up. */
export const ChangeOutcomes = { applied: 'applied', pendingApproval: 'pending_approval' } as const;
export type ChangeOutcome = (typeof ChangeOutcomes)[keyof typeof ChangeOutcomes];

/** How long a changeset waits for approval before it expires. */
export const CHANGESET_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A variant's value: JSON for `json` flags, otherwise the flag's type. */
export type VariantValue = boolean | string | number | Record<string, unknown> | unknown[];

/** A segment key: a lowercase slug, unique per environment. */
export const SEGMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** An evaluation-context attribute a clause reads (`plan`, `org.tier`, `targetingKey`). */
export const ATTRIBUTE_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

/** Limits the compiler and the evaluator rely on (feature flags design §11). */
export const FlagLimits = {
  rulesPerFlag: 50,
  clausesPerRule: 20,
  valuesPerClause: 1000,
  rolloutVariants: 20,
  segmentKeys: 10_000,
  segmentRuleGroups: 20,
  variantsPerFlag: 50,
  /** The compiled ruleset of one environment, serialized. */
  rulesetBytes: 5 * 1024 * 1024,
} as const;

export const ClauseOps = {
  in: 'in',
  notIn: 'not_in',
  startsWith: 'starts_with',
  endsWith: 'ends_with',
  lt: 'lt',
  lte: 'lte',
  gt: 'gt',
  gte: 'gte',
  semverEq: 'semver_eq',
  semverLt: 'semver_lt',
  semverLte: 'semver_lte',
  semverGt: 'semver_gt',
  semverGte: 'semver_gte',
} as const;
export type ClauseOp = (typeof ClauseOps)[keyof typeof ClauseOps];

/** Ops that compare against one value; the others match any of their values. */
export const SINGLE_VALUE_OPS: readonly ClauseOp[] = [
  ClauseOps.lt,
  ClauseOps.lte,
  ClauseOps.gt,
  ClauseOps.gte,
  ClauseOps.semverEq,
  ClauseOps.semverLt,
  ClauseOps.semverLte,
  ClauseOps.semverGt,
  ClauseOps.semverGte,
];
const NUMERIC_OPS: ReadonlySet<ClauseOp> = new Set([ClauseOps.lt, ClauseOps.lte, ClauseOps.gt, ClauseOps.gte]);
const STRING_OPS: ReadonlySet<ClauseOp> = new Set([
  ClauseOps.startsWith,
  ClauseOps.endsWith,
  ClauseOps.semverEq,
  ClauseOps.semverLt,
  ClauseOps.semverLte,
  ClauseOps.semverGt,
  ClauseOps.semverGte,
]);

/** `attribute op values`: e.g. `plan in [pro, enterprise]`, `appVersion semver_gte 2.4.0`. */
export const attributeClauseSchema = z
  .object({
    attribute: z.string().regex(ATTRIBUTE_PATTERN).max(100),
    op: z.enum(Object.values(ClauseOps) as [ClauseOp, ...ClauseOp[]]),
    values: z
      .array(z.union([z.string().max(500), z.number()]))
      .min(1)
      .max(FlagLimits.valuesPerClause),
  })
  .refine(clause => !SINGLE_VALUE_OPS.includes(clause.op) || clause.values.length === 1, {
    message: 'This operator compares against exactly one value',
    path: ['values'],
  })
  .refine(clause => !NUMERIC_OPS.has(clause.op) || clause.values.every(value => typeof value === 'number'), {
    message: 'Numeric comparisons take a number',
    path: ['values'],
  })
  .refine(clause => !STRING_OPS.has(clause.op) || clause.values.every(value => typeof value === 'string'), {
    message: 'This operator takes text',
    path: ['values'],
  });
export type AttributeClause = z.infer<typeof attributeClauseSchema>;

/** Membership of a segment of the same environment (`negate`: not a member). */
export const segmentClauseSchema = z.object({
  segment: z.string().regex(SEGMENT_KEY_PATTERN),
  negate: z.boolean().default(false),
});
export type SegmentClause = z.infer<typeof segmentClauseSchema>;

export const clauseSchema = z.union([attributeClauseSchema, segmentClauseSchema]);
export type Clause = z.infer<typeof clauseSchema>;

/** One variant's share of a percentage rollout. Order matters: raising a share only adds keys. */
export const rolloutEntrySchema = z.object({
  variant: z.string().regex(VARIANT_NAME_PATTERN),
  weight: z.number().int().min(0).max(100_000),
});
export type RolloutEntry = z.infer<typeof rolloutEntrySchema>;

/** What a rule (or the fallthrough) serves: one variant, or a percentage rollout. */
export const serveSchema = z.union([
  z.object({ variant: z.string().regex(VARIANT_NAME_PATTERN) }),
  z.object({
    rollout: z
      .array(rolloutEntrySchema)
      .min(1)
      .max(FlagLimits.rolloutVariants)
      .refine(entries => entries.some(entry => entry.weight > 0), { message: 'At least one weight above 0' }),
  }),
]);
export type Serve = z.infer<typeof serveSchema>;

/** A targeting rule: all its clauses match → it serves. Rules are tried in order. */
export const ruleSchema = z.object({
  clauses: z.array(clauseSchema).min(1).max(FlagLimits.clausesPerRule),
  serve: serveSchema,
});
export type Rule = z.infer<typeof ruleSchema>;

/** A segment's definition in one environment. Keys are targeting keys. */
export const segmentDefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  includedKeys: z.array(z.string().min(1).max(256)).max(FlagLimits.segmentKeys),
  excludedKeys: z.array(z.string().min(1).max(256)).max(FlagLimits.segmentKeys),
  /** OR of AND groups of attribute clauses. */
  rules: z
    .array(z.array(attributeClauseSchema).min(1).max(FlagLimits.clausesPerRule))
    .max(FlagLimits.segmentRuleGroups),
});
export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>;

const flagKeySchema = z.string().regex(FLAG_KEY_PATTERN);

/** One change to an environment's flag configs or segments. A changeset is an ordered list of these. */
export const changeOpSchema = z.discriminatedUnion('op', [
  /** Add a flag to the environment, disabled (callers get their code default) until enabled. */
  z.object({
    op: z.literal('add_flag'),
    flagKey: flagKeySchema,
    defaultVariant: z.string().regex(VARIANT_NAME_PATTERN),
    offVariant: z.string().regex(VARIANT_NAME_PATTERN),
  }),
  z.object({ op: z.literal('set_enabled'), flagKey: flagKeySchema, enabled: z.boolean() }),
  /** The variant served when no rule matches (and to keyless callers under a rollout). */
  z.object({
    op: z.literal('set_default_variant'),
    flagKey: flagKeySchema,
    variant: z.string().regex(VARIANT_NAME_PATTERN),
  }),
  /** Replace the flag's targeting rules. */
  z.object({
    op: z.literal('set_rules'),
    flagKey: flagKeySchema,
    rules: z.array(ruleSchema).max(FlagLimits.rulesPerFlag),
  }),
  /** Serve a percentage rollout when no rule matches; null serves the default variant. */
  z.object({
    op: z.literal('set_rollout'),
    flagKey: flagKeySchema,
    rollout: serveSchema.options[1].shape.rollout.nullable(),
  }),
  z.object({
    op: z.literal('set_segment'),
    segmentKey: z.string().regex(SEGMENT_KEY_PATTERN),
    segment: segmentDefinitionSchema,
  }),
  z.object({ op: z.literal('delete_segment'), segmentKey: z.string().regex(SEGMENT_KEY_PATTERN) }),
  /** Serve the off variant to everyone (the kill switch; `KillSwitchService` applies it ungated). */
  z.object({ op: z.literal('kill'), flagKey: flagKeySchema }),
  /** Undo a kill. A normal change: gated on a protected environment. */
  z.object({ op: z.literal('restore'), flagKey: flagKeySchema }),
  /** What a kill serves. A normal change: gated on a protected environment. */
  z.object({
    op: z.literal('set_off_variant'),
    flagKey: flagKeySchema,
    variant: z.string().regex(VARIANT_NAME_PATTERN),
  }),
]);
export type ChangeOp = z.infer<typeof changeOpSchema>;

/** One line of a changeset's rendered diff: a field of a flag's config or of a segment. */
export const changeDiffEntrySchema = z.object({
  subject: z.enum(['flag', 'segment']),
  key: z.string(),
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});
export type ChangeDiffEntry = z.infer<typeof changeDiffEntrySchema>;

export const flagEnvironmentSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  key: z.string(),
  name: z.string(),
  /** Set when the environment is protected (ADR 0023): changes need this gate's approval. */
  changeGate: gateRequirementsSchema.nullable(),
  /** Roles whose members may kill a flag here; empty: any workspace member. */
  killRoles: z.array(z.string()),
  currentVersion: z.number(),
  createdAt: z.date(),
});
export type FlagEnvironmentDto = z.infer<typeof flagEnvironmentSchema>;

export const flagEnvironmentCreateInputSchema = z.object({
  key: z.string().regex(FLAG_ENVIRONMENT_KEY_PATTERN),
  name: z.string().min(1).max(80),
});

const variantsSchema = z.record(z.string().regex(VARIANT_NAME_PATTERN), z.unknown());

export const flagSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  key: z.string(),
  type: z.enum([FlagTypes.boolean, FlagTypes.string, FlagTypes.number, FlagTypes.json]),
  variants: variantsSchema,
  description: z.string().nullable(),
  lifecycle: z.enum([FlagLifecycles.temporary, FlagLifecycles.permanent]),
  /** Evaluated for publishable (browser and app) keys over OFREP; server keys see every flag. */
  clientVisible: z.boolean(),
  managedBy: z.enum([FlagManagers.ui, FlagManagers.repo]),
  createdAt: z.date(),
});
export type FlagDto = z.infer<typeof flagSchema>;

/** A flag's state in one environment. */
export const flagConfigSchema = z.object({
  flagKey: z.string(),
  environmentId: z.uuid(),
  enabled: z.boolean(),
  killed: z.boolean(),
  defaultVariant: z.string(),
  offVariant: z.string(),
  rules: z.array(ruleSchema),
  rollout: z.array(rolloutEntrySchema).nullable(),
  version: z.number(),
});
export type FlagConfigDto = z.infer<typeof flagConfigSchema>;

/** Whether a variant value fits the flag's type (`json`: an object or an array). */
export function isVariantOfType(type: FlagType, value: unknown): boolean {
  if (type === FlagTypes.json) {
    return typeof value === 'object' && value !== null;
  }
  if (type === FlagTypes.number) {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return typeof value === type;
}

/** Create a flag of any type with its variants; it is added disabled to every environment. */
export const flagCreateInputSchema = z
  .object({
    key: z.string().regex(FLAG_KEY_PATTERN),
    type: z.enum([FlagTypes.boolean, FlagTypes.string, FlagTypes.number, FlagTypes.json]),
    variants: z.record(z.string().regex(VARIANT_NAME_PATTERN), z.unknown()).refine(variants => {
      const count = Object.keys(variants).length;
      return count >= 1 && count <= FlagLimits.variantsPerFlag;
    }, 'Between 1 and 50 variants'),
    /** Served once enabled, when no rule matches. */
    defaultVariant: z.string().regex(VARIANT_NAME_PATTERN),
    /** Served when the flag is killed. */
    offVariant: z.string().regex(VARIANT_NAME_PATTERN),
    description: z.string().max(500).nullable().default(null),
    lifecycle: z.enum([FlagLifecycles.temporary, FlagLifecycles.permanent]).default(FlagLifecycles.temporary),
  })
  .refine(input => Object.values(input.variants).every(value => isVariantOfType(input.type, value)), {
    message: 'Every variant value must match the flag type',
    path: ['variants'],
  })
  .refine(
    input => Object.hasOwn(input.variants, input.defaultVariant) && Object.hasOwn(input.variants, input.offVariant),
    {
      message: 'The default and off variants must be among the variants',
      path: ['defaultVariant'],
    },
  );
export type FlagCreateInput = z.infer<typeof flagCreateInputSchema>;

/** A segment as the console lists it. */
export const flagSegmentSchema = segmentDefinitionSchema.extend({
  key: z.string(),
  environmentId: z.uuid(),
  version: z.number(),
});
export type FlagSegmentDto = z.infer<typeof flagSegmentSchema>;

/** Create a boolean flag (variants `on` / `off`); it is added disabled to every environment. */
export const booleanFlagCreateInputSchema = z.object({
  key: z.string().regex(FLAG_KEY_PATTERN),
  description: z.string().max(500).nullable().default(null),
  lifecycle: z.enum([FlagLifecycles.temporary, FlagLifecycles.permanent]).default(FlagLifecycles.temporary),
});
export type BooleanFlagCreateInput = z.infer<typeof booleanFlagCreateInputSchema>;

export const changesetSchema = z.object({
  id: z.uuid(),
  environmentId: z.uuid(),
  state: z.enum(Object.values(ChangesetStates) as [ChangesetState, ...ChangesetState[]]),
  source: z.enum([ChangesetSources.ui, ChangesetSources.repo, ChangesetSources.api, ChangesetSources.kill]),
  ops: z.array(changeOpSchema),
  diff: z.array(changeDiffEntrySchema),
  contentHash: z.string(),
  baseVersion: z.number(),
  appliedVersion: z.number().nullable(),
  proposedByUserId: z.uuid().nullable(),
  reason: z.string().nullable(),
  /** For a repo changeset: the commit of `.mocco/flags.yml` it came from. */
  commitSha: z.string().nullable(),
  /** The approval request deciding it (protected environments only). */
  approvalRequestId: z.uuid().nullable(),
  /** The gate it was proposed under, pinned: a later gate edit doesn't change it. */
  requirements: gateRequirementsSchema.nullable(),
  expiresAt: z.date().nullable(),
  createdAt: z.date(),
  resolvedAt: z.date().nullable(),
});
export type ChangesetDto = z.infer<typeof changesetSchema>;

/** The bucketing algorithm Mocco's rulesets pin (ADR 0024). */
export const BUCKETING_VERSION = 'mocco-v1';
export const FLAGD_SCHEMA_URL = 'https://flagd.dev/schema/v0/flags.json';

/** Evaluation telemetry (#144): SDKs count evaluations per flag and variant over a window
 * and send the counts at most once a minute. Advisory only: stale detection reads it, no
 * governance decision does. */
export const FlagTelemetryLimits = {
  /** Entries per request. */
  maxEntries: 500,
  /** Evaluations one entry may report. */
  maxCount: 1_000_000,
  /** How far back a window may start; older counts are ignored. */
  maxWindowAgeMs: 24 * 60 * 60 * 1000,
  /** Clock skew allowed for a window starting in the future. */
  maxClockSkewMs: 5 * 60 * 1000,
} as const;

export const flagTelemetryEntrySchema = z.object({
  flag: flagKeySchema,
  /** The variant served; null when none was (a disabled flag, an error). */
  variant: z.string().regex(VARIANT_NAME_PATTERN).nullable(),
  count: z.int().min(1).max(FlagTelemetryLimits.maxCount),
  windowStart: z.iso.datetime({ offset: true }),
});
export type FlagTelemetryEntry = z.infer<typeof flagTelemetryEntrySchema>;

export const flagTelemetryInputSchema = z.object({
  evaluations: z.array(flagTelemetryEntrySchema).min(1).max(FlagTelemetryLimits.maxEntries),
});
export type FlagTelemetryInput = z.infer<typeof flagTelemetryInputSchema>;

/** Why a flag looks ready for cleanup. */
export const StaleKinds = {
  /** Evaluated before, but not in the last `staleDays`. */
  unused: 'unused',
  /** Older than `staleDays` and never evaluated. */
  neverEvaluated: 'never_evaluated',
  /** Serving one variant to everyone in every environment for `staleDays`. */
  fullyRolledOut: 'fully_rolled_out',
} as const;
export type StaleKind = (typeof StaleKinds)[keyof typeof StaleKinds];

/** How long a flag must look stale before it is reported. */
export const STALE_AFTER_DAYS = 30;

export const staleFindingSchema = z.object({
  id: z.uuid(),
  flagId: z.uuid(),
  flagKey: z.string(),
  kind: z.enum(Object.values(StaleKinds) as [StaleKind, ...StaleKind[]]),
  detectedAt: z.date(),
  /** When the flag was last evaluated anywhere, if ever (from telemetry). */
  lastEvaluatedAt: z.date().nullable(),
  /** For fully_rolled_out: the variant everyone gets. */
  servedVariant: z.string().nullable(),
  dismissedUntil: z.date().nullable(),
});
export type StaleFindingDto = z.infer<typeof staleFindingSchema>;

/** How a `.mocco/flags.yml` sync ended (#145). */
export const FlagFileSyncStates = {
  /** Every change applied (no environment it changed is protected). */
  applied: 'applied',
  /** Applied where unprotected; protected environments wait for approval. */
  pending: 'pending_approval',
  /** The file already matched the project. */
  unchanged: 'unchanged',
  /** The file was refused: nothing changed (see the issues). */
  invalid: 'invalid',
} as const;
export type FlagFileSyncState = (typeof FlagFileSyncStates)[keyof typeof FlagFileSyncStates];

/** One sync of a project's `.mocco/flags.yml` from a commit, as the console lists it. */
export const flagFileSyncSchema = z.object({
  id: z.uuid(),
  commitSha: z.string(),
  state: z.enum(Object.values(FlagFileSyncStates) as [FlagFileSyncState, ...FlagFileSyncState[]]),
  issues: z.array(z.object({ path: z.string(), message: z.string(), line: z.number().optional() })),
  createdAt: z.date(),
});
export type FlagFileSyncDto = z.infer<typeof flagFileSyncSchema>;
