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

/** Where a changeset came from. */
export const ChangesetSources = { ui: 'ui', repo: 'repo', api: 'api', kill: 'kill' } as const;
export type ChangesetSource = (typeof ChangesetSources)[keyof typeof ChangesetSources];

export const ChangesetStates = {
  pending: 'pending',
  applied: 'applied',
  rejected: 'rejected',
  conflicted: 'conflicted',
  superseded: 'superseded',
} as const;
export type ChangesetState = (typeof ChangesetStates)[keyof typeof ChangesetStates];

/** A variant's value: JSON for `json` flags, otherwise the flag's type. */
export type VariantValue = boolean | string | number | Record<string, unknown> | unknown[];

/** One change to an environment's flag configs. A changeset is an ordered list of these. */
export const changeOpSchema = z.discriminatedUnion('op', [
  /** Add a flag to the environment, disabled (callers get their code default) until enabled. */
  z.object({
    op: z.literal('add_flag'),
    flagKey: z.string().regex(FLAG_KEY_PATTERN),
    defaultVariant: z.string().regex(VARIANT_NAME_PATTERN),
    offVariant: z.string().regex(VARIANT_NAME_PATTERN),
  }),
  z.object({ op: z.literal('set_enabled'), flagKey: z.string().regex(FLAG_KEY_PATTERN), enabled: z.boolean() }),
  z.object({
    op: z.literal('set_default_variant'),
    flagKey: z.string().regex(FLAG_KEY_PATTERN),
    variant: z.string().regex(VARIANT_NAME_PATTERN),
  }),
]);
export type ChangeOp = z.infer<typeof changeOpSchema>;

/** One line of a changeset's rendered diff. */
export const changeDiffEntrySchema = z.object({
  flagKey: z.string(),
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
  version: z.number(),
});
export type FlagConfigDto = z.infer<typeof flagConfigSchema>;

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
  state: z.enum([
    ChangesetStates.pending,
    ChangesetStates.applied,
    ChangesetStates.rejected,
    ChangesetStates.conflicted,
    ChangesetStates.superseded,
  ]),
  source: z.enum([ChangesetSources.ui, ChangesetSources.repo, ChangesetSources.api, ChangesetSources.kill]),
  ops: z.array(changeOpSchema),
  diff: z.array(changeDiffEntrySchema),
  contentHash: z.string(),
  baseVersion: z.number(),
  appliedVersion: z.number().nullable(),
  proposedByUserId: z.uuid().nullable(),
  reason: z.string().nullable(),
  createdAt: z.date(),
  resolvedAt: z.date().nullable(),
});
export type ChangesetDto = z.infer<typeof changesetSchema>;

/** The bucketing algorithm Mocco's rulesets pin (ADR 0024). */
export const BUCKETING_VERSION = 'mocco-v1';
export const FLAGD_SCHEMA_URL = 'https://flagd.dev/schema/v0/flags.json';
