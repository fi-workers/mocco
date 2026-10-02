// The compiled ruleset evaluated by @mocco/flags-core and by OpenFeature's own
// @openfeature/flagd-core (a dev dependency) must agree, flag by flag and context by
// context: it is what lets flagd and flagd providers consume Mocco's rulesets unchanged.
import { resolveFlag } from '@mocco/flags-core';
import { FlagdCore } from '@openfeature/flagd-core';
import { describe, expect, it } from 'vitest';

import { compileRuleset } from '@backend/domain/flags/compile-ruleset';

import type { FlagConfigState } from '@backend/domain/flags/apply-ops';
import type { CompiledFlagInput } from '@backend/domain/flags/compile-ruleset';
import type { SegmentDefinition } from '@mocco/common/flags';

const config = (overrides: Partial<FlagConfigState>): FlagConfigState => ({
  enabled: true,
  killed: false,
  defaultVariant: 'off',
  offVariant: 'off',
  rules: [],
  rollout: null,
  ...overrides,
});
const flag = (
  key: string,
  variants: Record<string, unknown>,
  overrides: Partial<FlagConfigState>,
): CompiledFlagInput => ({
  key,
  variants,
  lifecycle: 'temporary',
  salt: `salt-${key}`,
  config: config(overrides),
});

const segments = new Map<string, SegmentDefinition>([
  [
    'beta',
    {
      name: 'Beta',
      includedKeys: ['user-1', 'user-2', 'user-3'],
      excludedKeys: ['user-4'],
      rules: [
        [{ attribute: 'email', op: 'ends_with', values: ['@acme.test'] }],
        [
          { attribute: 'plan', op: 'in', values: ['pro'] },
          { attribute: 'seats', op: 'gt', values: [20] },
        ],
      ],
    },
  ],
]);

const flags: CompiledFlagInput[] = [
  flag(
    'checkout',
    { on: true, off: false },
    {
      rules: [
        { clauses: [{ segment: 'beta', negate: false }], serve: { variant: 'on' } },
        {
          clauses: [
            { attribute: 'country', op: 'not_in', values: ['US'] },
            { attribute: 'appVersion', op: 'semver_gte', values: ['2.1.0'] },
          ],
          serve: {
            rollout: [
              { variant: 'on', weight: 30 },
              { variant: 'off', weight: 70 },
            ],
          },
        },
      ],
      rollout: [
        { variant: 'on', weight: 5 },
        { variant: 'off', weight: 95 },
      ],
    },
  ),
  flag(
    'copy',
    { short: 'Pay', long: 'Pay securely', none: '' },
    {
      defaultVariant: 'short',
      offVariant: 'none',
      rules: [
        { clauses: [{ attribute: 'email', op: 'starts_with', values: ['ceo@', 'cfo@'] }], serve: { variant: 'long' } },
        {
          clauses: [
            { segment: 'beta', negate: true },
            { attribute: 'seats', op: 'lte', values: [3] },
          ],
          serve: { variant: 'none' },
        },
      ],
    },
  ),
  flag(
    'limit',
    { low: 10, mid: 50, high: 200 },
    {
      defaultVariant: 'low',
      offVariant: 'low',
      rollout: [
        { variant: 'low', weight: 1 },
        { variant: 'mid', weight: 2 },
        { variant: 'high', weight: 1 },
      ],
    },
  ),
  flag(
    'layout',
    { a: { columns: 2 }, b: { columns: 3, dense: true } },
    {
      defaultVariant: 'a',
      offVariant: 'a',
      rules: [{ clauses: [{ attribute: 'appVersion', op: 'semver_lt', values: ['2.0.0'] }], serve: { variant: 'b' } }],
    },
  ),
  flag(
    'killed',
    { on: true, off: false },
    { killed: true, rules: [{ clauses: [{ segment: 'beta', negate: false }], serve: { variant: 'on' } }] },
  ),
  flag('disabled', { on: true, off: false }, { enabled: false }),
];

/** A deterministic pseudo-random source (a linear congruential generator), so failures reproduce. */
function random(seed: number) {
  let state = seed % 2_147_483_647;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}

function contextAt(next: () => number, index: number): Record<string, unknown> {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const context: Record<string, unknown> = {};
  if (next() > 0.1) {
    context.targetingKey = `user-${index % 7 === 0 ? Math.floor(next() * 6) : index}`;
  }
  if (next() > 0.3) {
    context.email = `${pick(['ceo', 'dev', 'cfo', 'ann'])}@${pick(['acme.test', 'other.test'])}`;
  }
  if (next() > 0.3) {
    context.plan = pick(['free', 'pro', 'enterprise']);
  }
  if (next() > 0.3) {
    context.seats = Math.floor(next() * 40);
  }
  if (next() > 0.3) {
    context.country = pick(['US', 'KR', 'DE']);
  }
  if (next() > 0.3) {
    context.appVersion = pick(['1.9.9', '2.0.0', '2.1.0', '2.1.0-beta.1', '3.0.1']);
  }
  return context;
}

describe('compiled rulesets: @mocco/flags-core agrees with @openfeature/flagd-core', () => {
  const document = compileRuleset({ key: 'production', version: 7 }, flags, segments, new Date('2026-10-02T00:00:00Z'));
  const flagd = new FlagdCore();
  flagd.setConfigurations(JSON.stringify(document));
  const next = random(20_261_002);
  const contexts = Array.from({ length: 3000 }, (_, index) => contextAt(next, index));
  /** flagd-core type-checks per resolver, so use the one matching the flag's variants. */
  const resolveWithFlagd = (key: string, context: Record<string, unknown>) => {
    const sample = Object.values(flags.find(item => item.key === key)?.variants ?? {})[0];
    const ctx = context as never;
    if (typeof sample === 'boolean') {
      return flagd.resolveBooleanEvaluation(key, false, ctx);
    }
    if (typeof sample === 'string') {
      return flagd.resolveStringEvaluation(key, '', ctx);
    }
    if (typeof sample === 'number') {
      return flagd.resolveNumberEvaluation(key, 0, ctx);
    }
    return flagd.resolveObjectEvaluation(key, {}, ctx);
  };

  it.each(flags.map(item => item.key))('%s resolves identically for 3000 contexts', key => {
    const mismatches = contexts.flatMap(context => {
      const ours = resolveFlag(document, key, context);
      const theirs = resolveWithFlagd(key, context);
      const isDisabledOrDefault = ours.value === undefined;
      const isSame =
        theirs.reason === ours.reason &&
        (isDisabledOrDefault ||
          (JSON.stringify(theirs.value) === JSON.stringify(ours.value) && theirs.variant === ours.variant));
      return isSame
        ? []
        : [{ context, ours, theirs: { value: theirs.value, variant: theirs.variant, reason: theirs.reason } }];
    });

    expect(mismatches.slice(0, 3)).toEqual([]);
  });
});
