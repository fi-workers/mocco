// OFREP (OpenFeature Remote Evaluation Protocol) evaluation of a compiled ruleset: what
// browsers and apps get instead of the ruleset (ADR 0024 §3). Pure. Only resolved values
// leave the server: no rules, no segment lists, no Mocco metadata.
import { createHash } from 'node:crypto';

import { resolveFlag } from '@mocco/flags-core';

import { canonicalize } from '@backend/domain/audit/chain';

import type { EvaluationContext, Resolution, Ruleset } from '@mocco/flags-core';

/** OFREP's success reasons (its OpenAPI enum). */
type OfrepReason = 'STATIC' | 'TARGETING_MATCH' | 'SPLIT' | 'DISABLED' | 'UNKNOWN';
/** OFREP's evaluation-failure codes (its OpenAPI enum). */
type OfrepErrorCode = 'PARSE_ERROR' | 'TARGETING_KEY_MISSING' | 'INVALID_CONTEXT' | 'GENERAL';

export interface OfrepSuccess {
  key: string;
  reason: OfrepReason;
  variant?: string;
  value?: unknown;
}
export interface OfrepFailure {
  key: string;
  errorCode: OfrepErrorCode;
  errorDetails?: string;
}
export interface OfrepNotFound {
  key: string;
  errorCode: 'FLAG_NOT_FOUND';
  errorDetails: string;
}
export type OfrepResult = OfrepSuccess | OfrepFailure | OfrepNotFound;

/**
 * flags-core's reasons onto OFREP's enum. OFREP has no DEFAULT: a flag that fell through
 * its rules to the default variant is reported as STATIC (a configured value, not a
 * targeting decision).
 */
const reasons: Record<Resolution['reason'], OfrepReason> = {
  STATIC: 'STATIC',
  DEFAULT: 'STATIC',
  TARGETING_MATCH: 'TARGETING_MATCH',
  DISABLED: 'DISABLED',
  ERROR: 'UNKNOWN',
};

/** One flag, as OFREP reports it. A value the caller's code default should replace
 * (disabled, or no default variant) is omitted: OFREP's `codeDefaultFlag`. */
// eslint-disable-next-line sonarjs/function-return-type -- OFREP's union: success, failure or not found
export function ofrepResult(ruleset: Ruleset, key: string, context: EvaluationContext, now?: Date): OfrepResult {
  const resolution = resolveFlag(ruleset, key, context, now);
  if (resolution.errorCode === 'FLAG_NOT_FOUND') {
    return { key, errorCode: 'FLAG_NOT_FOUND', errorDetails: `Flag "${key}" was not found` };
  }
  if (resolution.errorCode !== undefined) {
    return {
      key,
      errorCode: resolution.errorCode === 'PARSE_ERROR' ? 'PARSE_ERROR' : 'GENERAL',
      errorDetails: resolution.errorMessage ?? 'The flag could not be evaluated',
    };
  }
  return {
    key,
    reason: reasons[resolution.reason],
    ...(resolution.variant !== undefined && { variant: resolution.variant }),
    ...(resolution.value !== undefined && { value: resolution.value }),
  };
}

/** Every flag `visible` allows, evaluated for one context (OFREP bulk). */
export function ofrepBulk(
  ruleset: Ruleset,
  isVisible: (key: string) => boolean,
  context: EvaluationContext,
  now?: Date,
): OfrepResult[] {
  return (
    Object.keys(ruleset.flags)
      .filter(key => isVisible(key))
      // eslint-disable-next-line sonarjs/null-dereference -- flag keys are strings
      .toSorted((a, b) => a.localeCompare(b))
      .map(key => ofrepResult(ruleset, key, context, now))
  );
}

/** The bulk ETag: the ruleset's version, what the key may see, and the context. */
export function ofrepEtag(rulesetEtag: string, audience: 'server' | 'client', context: EvaluationContext): string {
  const digest = createHash('sha256').update(canonicalize({ rulesetEtag, audience, context })).digest('base64url');
  return `"${digest}"`;
}

/** A JSON object body's `context`, or null when the body isn't an OFREP request. */
// eslint-disable-next-line sonarjs/function-return-type -- null is the "not an OFREP request" answer
export function ofrepContextOf(body: unknown): EvaluationContext | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const { context } = body as { context?: unknown };
  if (context === undefined) {
    return {};
  }
  return typeof context === 'object' && context !== null && !Array.isArray(context)
    ? (context as EvaluationContext)
    : null;
}
