import { createHash } from 'node:crypto';

import { BUCKETING_VERSION, FLAGD_SCHEMA_URL } from '@mocco/common/flags';

import { canonicalize } from '@backend/domain/audit/chain';

import type { FlagConfigState } from '@backend/domain/flags/apply-ops';
import type { FlagLifecycle } from '@mocco/common/flags';

/** One flag of an environment, as the compiler needs it. */
export interface CompiledFlagInput {
  key: string;
  variants: Record<string, unknown>;
  lifecycle: FlagLifecycle;
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

/**
 * Compile an environment's flags into the flagd document SDKs evaluate (ADR 0024).
 * flagd metadata values must be primitives, so Mocco's metadata is flat `mocco.*`
 * keys. A disabled flag is `state: DISABLED` (callers get their code default); a
 * killed flag stays ENABLED but serves its off variant with no targeting, so even a
 * stale or third-party flagd client serves the off variant.
 */
export function compileRuleset(
  environment: { key: string; version: number },
  flags: readonly CompiledFlagInput[],
  generatedAt: Date,
): FlagdDocument {
  const compiled: FlagdDocument['flags'] = Object.fromEntries(
    flags.map(({ key, variants, lifecycle, config }) => [
      key,
      {
        state: config.enabled || config.killed ? 'ENABLED' : 'DISABLED',
        variants,
        defaultVariant: config.killed ? config.offVariant : config.defaultVariant,
        targeting: {},
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
