// `.mocco/flags.yml` (#145): feature flags declared in the repository. A push to the
// default branch turns the file into changesets, one per environment it touches; on a
// protected environment they still wait for the gate's approval. The file holds the
// desired state of the flags it lists: their definitions, and in each target (an
// environment key) whether they are on, what they serve by default, their rules and
// their rollout. A kill is never in the file: it stays a console action.
import { z } from 'zod';

import {
  ATTRIBUTE_PATTERN,
  ClauseOps,
  FLAG_ENVIRONMENT_KEY_PATTERN,
  FLAG_KEY_PATTERN,
  FlagLifecycles,
  FlagLimits,
  FlagTypes,
  isVariantOfType,
  SEGMENT_KEY_PATTERN,
  VARIANT_NAME_PATTERN,
} from './flags';

import type { ClauseOp } from './flags';

export const FLAGS_FILE_PATH = '.mocco/flags.yml';

/** Flags one file may declare. */
export const FLAGS_FILE_MAX_FLAGS = 500;

const variantName = z.string().regex(VARIANT_NAME_PATTERN);

/** Weights by variant, in order: `{ on: 10, off: 90 }`. */
const rolloutWeights = z
  .record(variantName, z.number().int().min(0).max(100_000))
  .refine(weights => Object.keys(weights).length > 0 && Object.keys(weights).length <= FlagLimits.rolloutVariants, {
    message: `Between 1 and ${FlagLimits.rolloutVariants} variants`,
  })
  .refine(weights => Object.values(weights).some(weight => weight > 0), { message: 'At least one weight above 0' });

/** What a rule serves: a variant name, or `{ rollout: { on: 10, off: 90 } }`. */
const serveFileSchema = z.union([variantName, z.strictObject({ rollout: rolloutWeights })]);

const attributeClauseFileSchema = z.strictObject({
  attribute: z.string().regex(ATTRIBUTE_PATTERN).max(100),
  op: z.enum(Object.values(ClauseOps) as [ClauseOp, ...ClauseOp[]]),
  values: z
    .array(z.union([z.string().max(500), z.number()]))
    .min(1)
    .max(FlagLimits.valuesPerClause),
});

const segmentClauseFileSchema = z.strictObject({
  segment: z.string().regex(SEGMENT_KEY_PATTERN),
  negate: z.boolean().optional(),
});

const clauseFileSchema = z.union([attributeClauseFileSchema, segmentClauseFileSchema]);

/** A rule: `when` (one clause, or a list that must all match) and what it serves. */
const ruleFileSchema = z.strictObject({
  when: z.union([clauseFileSchema, z.array(clauseFileSchema).min(1).max(FlagLimits.clausesPerRule)]),
  serve: serveFileSchema,
});

/** A flag in one environment. Environments the flag doesn't list keep it off. */
const targetFileSchema = z.strictObject({
  /** Off serves callers their code default. */
  enabled: z.boolean().default(true),
  /** Served when no rule matches (without a rollout). */
  default: variantName,
  rules: z.array(ruleFileSchema).max(FlagLimits.rulesPerFlag).default([]),
  /** Served when no rule matches, instead of `default`. */
  rollout: rolloutWeights.optional(),
});

const flagFileSchema = z.strictObject({
  type: z.enum([FlagTypes.boolean, FlagTypes.string, FlagTypes.number, FlagTypes.json]).default(FlagTypes.boolean),
  description: z.string().max(500).optional(),
  lifecycle: z.enum([FlagLifecycles.temporary, FlagLifecycles.permanent]).default(FlagLifecycles.temporary),
  /** Evaluated for publishable (browser and app) keys too. */
  client_visible: z.boolean().default(false),
  /** Required unless the flag is boolean, which defaults to `{ on: true, off: false }`. */
  variants: z.record(variantName, z.unknown()).optional(),
  /** What a kill serves. Defaults to `off` for a boolean flag. */
  off_variant: variantName.optional(),
  targets: z.record(z.string().regex(FLAG_ENVIRONMENT_KEY_PATTERN), targetFileSchema).default({}),
});

const BOOLEAN_VARIANTS = { on: true, off: false } as const;

interface FileIssue {
  path: (string | number)[];
  message: string;
}

type ParsedFlag = z.infer<typeof flagFileSchema>;

const servedVariants = (serve: z.infer<typeof serveFileSchema>): string[] =>
  typeof serve === 'string' ? [serve] : Object.keys(serve.rollout);

/** What's wrong with one flag: variants that don't fit its type, or names it uses but doesn't have. */
function issuesOfFlag(key: string, flag: ParsedFlag): FileIssue[] {
  const at = ['flags', key];
  const variants = flag.variants ?? (flag.type === FlagTypes.boolean ? BOOLEAN_VARIANTS : undefined);
  if (variants === undefined) {
    return [{ path: [...at, 'variants'], message: 'A non-boolean flag lists its variants' }];
  }
  const names = Object.keys(variants);
  const missing = (variant: string, path: (string | number)[]): FileIssue[] =>
    names.includes(variant) ? [] : [{ path: [...at, ...path], message: `No variant "${variant}"` }];
  const offVariant = flag.off_variant ?? (flag.type === FlagTypes.boolean ? 'off' : undefined);
  return [
    ...(names.length === 0 || names.length > FlagLimits.variantsPerFlag
      ? [{ path: [...at, 'variants'], message: `Between 1 and ${FlagLimits.variantsPerFlag} variants` }]
      : []),
    ...Object.entries(variants)
      .filter(([, value]) => !isVariantOfType(flag.type, value))
      .map(([name]) => ({ path: [...at, 'variants', name], message: `Not a ${flag.type} value` })),
    ...(offVariant === undefined
      ? [{ path: [...at, 'off_variant'], message: 'A non-boolean flag names its off_variant' }]
      : missing(offVariant, ['off_variant'])),
    ...Object.entries(flag.targets).flatMap(([target, config]) => [
      ...missing(config.default, ['targets', target, 'default']),
      ...Object.keys(config.rollout ?? {}).flatMap(variant =>
        missing(variant, ['targets', target, 'rollout', variant]),
      ),
      ...config.rules.flatMap((rule, index) =>
        servedVariants(rule.serve).flatMap(variant => missing(variant, ['targets', target, 'rules', index, 'serve'])),
      ),
    ]),
  ];
}

export const flagsFileSchema = z
  .strictObject({
    version: z.literal(1),
    flags: z
      .record(z.string().regex(FLAG_KEY_PATTERN), flagFileSchema)
      .refine(flags => Object.keys(flags).length <= FLAGS_FILE_MAX_FLAGS, {
        message: `At most ${FLAGS_FILE_MAX_FLAGS} flags`,
      }),
  })
  .superRefine((file, ctx) => {
    const issues = Object.entries(file.flags).flatMap(([key, flag]) => issuesOfFlag(key, flag));
    // eslint-disable-next-line no-restricted-syntax -- zod takes issues one at a time
    for (const issue of issues) {
      ctx.addIssue({ code: 'custom', ...issue });
    }
  });
export type FlagsFile = z.infer<typeof flagsFileSchema>;
export type FlagsFileFlag = FlagsFile['flags'][string];

/** A flag's variants, defaulting a boolean flag's to `{ on: true, off: false }`. */
export function variantsOfFileFlag(flag: FlagsFileFlag): Record<string, unknown> {
  return flag.variants ?? { ...BOOLEAN_VARIANTS };
}

/** A flag's off variant, defaulting a boolean flag's to `off`. */
export function offVariantOfFileFlag(flag: FlagsFileFlag): string {
  return flag.off_variant ?? 'off';
}
