// Resolving one flag against an evaluation context, with flagd's reasons and error codes.
import { applyLogic, FLAGD_PROPERTIES_KEY, LogicError } from './json-logic';

import type { FlagMetadata, Ruleset } from './ruleset';

/** OpenFeature resolution reasons (the subset flagd produces). */
export const Reasons = {
  static: 'STATIC',
  default: 'DEFAULT',
  targetingMatch: 'TARGETING_MATCH',
  disabled: 'DISABLED',
  error: 'ERROR',
} as const;
export type Reason = (typeof Reasons)[keyof typeof Reasons];

/** OpenFeature error codes. */
export const ErrorCodes = {
  flagNotFound: 'FLAG_NOT_FOUND',
  parseError: 'PARSE_ERROR',
  typeMismatch: 'TYPE_MISMATCH',
  general: 'GENERAL',
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type EvaluationContext = Record<string, unknown>;

/** The untyped result: `value` is undefined when the caller's default applies. */
export interface Resolution {
  value: unknown;
  variant?: string;
  reason: Reason;
  errorCode?: ErrorCode;
  errorMessage?: string;
  flagMetadata: FlagMetadata;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasTargeting = (targeting: unknown): boolean =>
  targeting !== undefined && targeting !== null && !(isPlainObject(targeting) && Object.keys(targeting).length === 0);

/**
 * Resolve `flagKey`. Mirrors flagd: an unknown flag is FLAG_NOT_FOUND; a disabled one is
 * DISABLED (the caller's default); targeting that returns null falls back to the default
 * variant (DEFAULT), a variant name is TARGETING_MATCH, an unknown name is GENERAL; no
 * targeting is STATIC. The context gains `$flagd.flagKey` and `$flagd.timestamp` (seconds).
 * Pure and synchronous: no I/O.
 */
export function resolveFlag(
  ruleset: Ruleset,
  flagKey: string,
  context: EvaluationContext = {},
  now: Date = new Date(),
): Resolution {
  const flag = Object.hasOwn(ruleset.flags, flagKey) ? ruleset.flags[flagKey] : undefined;
  const flagMetadata = { ...ruleset.metadata, ...flag?.metadata };
  if (flag === undefined) {
    return {
      value: undefined,
      reason: Reasons.error,
      errorCode: ErrorCodes.flagNotFound,
      errorMessage: `Flag "${flagKey}" isn't in the ruleset`,
      flagMetadata,
    };
  }
  if (flag.state === 'DISABLED') {
    return { value: undefined, reason: Reasons.disabled, flagMetadata };
  }
  const served = (variant: string | null, reason: Reason): Resolution =>
    variant === null
      ? { value: undefined, reason: Reasons.default, flagMetadata }
      : { value: flag.variants[variant], variant, reason, flagMetadata };

  if (!hasTargeting(flag.targeting)) {
    return served(flag.defaultVariant, Reasons.static);
  }
  let result: unknown;
  try {
    result = applyLogic(flag.targeting, {
      ...context,
      [FLAGD_PROPERTIES_KEY]: { flagKey, timestamp: Math.floor(now.getTime() / 1000) },
    });
  } catch (error) {
    return {
      value: undefined,
      reason: Reasons.error,
      errorCode: ErrorCodes.parseError,
      errorMessage: error instanceof LogicError ? error.message : 'Targeting failed to evaluate',
      flagMetadata,
    };
  }
  if (result === null || result === undefined) {
    return served(flag.defaultVariant, Reasons.default);
  }
  const variant = typeof result === 'string' ? result : JSON.stringify(result);
  if (!Object.hasOwn(flag.variants, variant)) {
    return {
      value: undefined,
      reason: Reasons.error,
      errorCode: ErrorCodes.general,
      errorMessage: `Targeting chose "${variant}", which isn't a variant of "${flagKey}"`,
      flagMetadata,
    };
  }
  return served(variant, Reasons.targetingMatch);
}

export type FlagValueType = 'boolean' | 'string' | 'number' | 'object';

/** A typed result: `value` is the resolved value or the caller's default. */
export interface TypedResolution<T> extends Omit<Resolution, 'value'> {
  value: T;
}

const isOfType = (value: unknown, type: FlagValueType): boolean =>
  type === 'object' ? typeof value === 'object' && value !== null : typeof value === type;

/** Resolve and check the value's type; any miss or error serves `defaultValue`. */
export function resolveTyped<T>(
  ruleset: Ruleset,
  flagKey: string,
  type: FlagValueType,
  defaultValue: T,
  context: EvaluationContext = {},
  now: Date = new Date(),
): TypedResolution<T> {
  const resolution = resolveFlag(ruleset, flagKey, context, now);
  if (resolution.value === undefined) {
    return { ...resolution, value: defaultValue };
  }
  if (!isOfType(resolution.value, type)) {
    return {
      value: defaultValue,
      reason: Reasons.error,
      errorCode: ErrorCodes.typeMismatch,
      errorMessage: `Flag "${flagKey}" is not a ${type}`,
      flagMetadata: resolution.flagMetadata,
    };
  }
  return { ...resolution, value: resolution.value as T };
}
