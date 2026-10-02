// A flagd v0 flag-definition document as Mocco serves it (`GET /v1/flags/ruleset`), and
// the structural check an SDK runs before it starts using one.
import { validateLogic } from './json-logic';

export type FlagMetadata = Record<string, string | number | boolean>;

export interface FlagDefinition {
  state: 'ENABLED' | 'DISABLED';
  variants: Record<string, unknown>;
  /** Null: no default — an evaluation that reaches it serves the caller's code default. */
  defaultVariant: string | null;
  targeting?: unknown;
  metadata?: FlagMetadata;
}

export interface Ruleset {
  $schema?: string;
  metadata?: FlagMetadata;
  flags: Record<string, FlagDefinition>;
}

export type RulesetCheck = { ok: true; ruleset: Ruleset } | { ok: false; errors: string[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPrimitiveRecord = (value: unknown): boolean =>
  isPlainObject(value) && Object.values(value).every(item => ['string', 'number', 'boolean'].includes(typeof item));

function flagErrors(key: string, flag: unknown): string[] {
  if (!isPlainObject(flag)) {
    return [`flags.${key}: not an object`];
  }
  const errors: string[] = [];
  if (flag.state !== 'ENABLED' && flag.state !== 'DISABLED') {
    errors.push(`flags.${key}.state: ENABLED or DISABLED`);
  }
  const { variants, defaultVariant, targeting, metadata } = flag;
  if (!isPlainObject(variants) || Object.keys(variants).length === 0) {
    errors.push(`flags.${key}.variants: at least one variant`);
  }
  const isKnownVariant =
    typeof defaultVariant === 'string' && isPlainObject(variants) && Object.hasOwn(variants, defaultVariant);
  if (defaultVariant !== null && !isKnownVariant) {
    errors.push(`flags.${key}.defaultVariant: one of the variants, or null`);
  }
  if (metadata !== undefined && !isPrimitiveRecord(metadata)) {
    errors.push(`flags.${key}.metadata: string, number or boolean values only`);
  }
  if (targeting !== undefined) {
    errors.push(...validateLogic(targeting, `flags.${key}.targeting`));
  }
  return errors;
}

/** Check a document's shape and that its targeting stays within the supported subset. */
// eslint-disable-next-line sonarjs/function-return-type -- a tagged union, discriminated by `ok`
export function parseRuleset(document: unknown): RulesetCheck {
  if (!isPlainObject(document) || !isPlainObject(document.flags)) {
    return { ok: false, errors: ['flags: missing or not an object'] };
  }
  const errors = [
    ...(document.metadata !== undefined && !isPrimitiveRecord(document.metadata)
      ? ['metadata: string, number or boolean values only']
      : []),
    ...Object.entries(document.flags).flatMap(([key, flag]) => flagErrors(key, flag)),
  ];
  return errors.length === 0 ? { ok: true, ruleset: document as unknown as Ruleset } : { ok: false, errors };
}
