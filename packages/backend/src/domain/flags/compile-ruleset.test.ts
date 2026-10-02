import { resolveFlag } from '@mocco/flags-core';
import { describe, expect, it } from 'vitest';

import { compileRuleset, rulesetEtag } from '@backend/domain/flags/compile-ruleset';
import { flagdValidator } from '@backend/domain/flags/testing/flagd-schema';

import type { FlagConfigState } from '@backend/domain/flags/apply-ops';
import type { CompiledFlagInput } from '@backend/domain/flags/compile-ruleset';
import type { RolloutEntry, SegmentDefinition } from '@mocco/common/flags';
import type { Ruleset } from '@mocco/flags-core';

const base: FlagConfigState = {
  enabled: false,
  killed: false,
  defaultVariant: 'on',
  offVariant: 'off',
  rules: [],
  rollout: null,
};
const BOOLEAN_VARIANTS = { on: true, off: false };
const flag = (
  key: string,
  config: Partial<FlagConfigState> = {},
  variants?: Record<string, unknown>,
): CompiledFlagInput => ({
  key,
  variants: variants ?? BOOLEAN_VARIANTS,
  lifecycle: 'temporary',
  salt: `salt-${key}`,
  config: { ...base, ...config },
});
const at = new Date('2026-10-02T00:00:00.000Z');
const noSegments = new Map<string, SegmentDefinition>();
const compile = (flags: CompiledFlagInput[], segments = noSegments) =>
  compileRuleset({ key: 'production', version: 3 }, flags, segments, at);
const variantOf = (document: unknown, key: string, context: Record<string, unknown>) =>
  resolveFlag(document as Ruleset, key, context).variant;

const segments = new Map<string, SegmentDefinition>([
  [
    'beta',
    {
      name: 'Beta',
      includedKeys: ['u-included'],
      excludedKeys: ['u-excluded'],
      rules: [[{ attribute: 'email', op: 'ends_with', values: ['@acme.test'] }]],
    },
  ],
]);

/** A boolean flag rolled out to `percent`% (`on` first, so raising it only adds keys). */
const ramp = (percent: number) =>
  compile([
    flag('ramp', {
      enabled: true,
      defaultVariant: 'off',
      rollout: [
        { variant: 'on', weight: percent },
        { variant: 'off', weight: 100 - percent },
      ],
    }),
  ]);

describe('compileRuleset', () => {
  it('emits a document valid against the flagd v0 schema, with rules, segments and rollouts', async () => {
    const validate = await flagdValidator();
    const document = compile(
      [
        flag('new-checkout', {
          enabled: true,
          rules: [
            { clauses: [{ attribute: 'plan', op: 'in', values: ['enterprise'] }], serve: { variant: 'on' } },
            {
              clauses: [{ segment: 'beta', negate: false }],
              serve: {
                rollout: [
                  { variant: 'on', weight: 50 },
                  { variant: 'off', weight: 50 },
                ],
              },
            },
          ],
          rollout: [
            { variant: 'on', weight: 10 },
            { variant: 'off', weight: 90 },
          ],
        }),
        flag('dark-mode'),
        flag('beta', {
          killed: true,
          rules: [{ clauses: [{ attribute: 'x', op: 'in', values: [1] }], serve: { variant: 'on' } }],
        }),
      ],
      segments,
    );

    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(compile([]))).toBe(true);
  });

  it('serves the code default when disabled and the off variant, untargeted, when killed', () => {
    const { flags, metadata } = compile([
      flag('enabled', { enabled: true }),
      flag('disabled'),
      flag('killed', {
        enabled: true,
        killed: true,
        rules: [{ clauses: [{ attribute: 'a', op: 'in', values: ['b'] }], serve: { variant: 'on' } }],
      }),
      flag('killed-while-disabled', { killed: true }),
    ]);

    expect(metadata).toEqual({
      'mocco.environment': 'production',
      'mocco.version': 3,
      'mocco.generatedAt': '2026-10-02T00:00:00.000Z',
      'mocco.bucketing': 'mocco-v1',
    });
    expect(flags.enabled).toMatchObject({ state: 'ENABLED', defaultVariant: 'on', targeting: {} });
    expect(flags.disabled).toMatchObject({ state: 'DISABLED' });
    const killed = { state: 'ENABLED', defaultVariant: 'off', targeting: {}, metadata: { 'mocco.killed': true } };
    expect([flags.killed, flags['killed-while-disabled']]).toMatchObject([killed, killed]);
  });

  it('evaluates rules in order, with every clause operator and segment membership', () => {
    const document = compile(
      [
        flag(
          'tier',
          {
            enabled: true,
            defaultVariant: 'basic',
            rules: [
              { clauses: [{ segment: 'beta', negate: false }], serve: { variant: 'beta' } },
              {
                clauses: [
                  { attribute: 'plan', op: 'in', values: ['pro', 'enterprise'] },
                  { attribute: 'seats', op: 'gte', values: [10] },
                ],
                serve: { variant: 'big' },
              },
              {
                clauses: [{ attribute: 'appVersion', op: 'semver_lt', values: ['2.0.0'] }],
                serve: { variant: 'legacy' },
              },
              { clauses: [{ attribute: 'country', op: 'not_in', values: ['US', 'CA'] }], serve: { variant: 'intl' } },
            ],
          },
          { basic: 'basic', beta: 'beta', big: 'big', legacy: 'legacy', intl: 'intl' },
        ),
      ],
      segments,
    );
    const tier = (context: Record<string, unknown>) => variantOf(document, 'tier', { country: 'US', ...context });

    expect([
      tier({ targetingKey: 'u-included' }),
      tier({ targetingKey: 'u2', email: 'ann@acme.test' }),
      tier({ targetingKey: 'u-excluded', email: 'bob@acme.test', plan: 'pro', seats: 12 }),
      tier({ targetingKey: 'u3', plan: 'pro', seats: 3 }),
      tier({ targetingKey: 'u3', plan: 'pro' }),
      tier({ targetingKey: 'u4', appVersion: '1.9.3' }),
      tier({ targetingKey: 'u5', appVersion: '2.1.0', country: 'KR' }),
      tier({ targetingKey: 'u6' }),
    ]).toEqual(['beta', 'beta', 'big', 'basic', 'basic', 'legacy', 'intl', 'basic']);
  });

  it('distributes 100K keys within ±1% of the rollout weights, and serves keyless callers the default', () => {
    const rollout: RolloutEntry[] = [
      { variant: 'a', weight: 10 },
      { variant: 'b', weight: 30 },
      { variant: 'c', weight: 60 },
    ];
    const document = compile([
      flag('split', { enabled: true, defaultVariant: 'a', rollout }, { a: 'a', b: 'b', c: 'c' }),
    ]);
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let index = 0; index < 100_000; index += 1) {
      const variant = variantOf(document, 'split', { targetingKey: `user-${index}` }) ?? 'none';
      counts[variant] = (counts[variant] ?? 0) + 1;
    }

    expect(Math.abs((counts.a ?? 0) / 1000 - 10)).toBeLessThan(1);
    expect(Math.abs((counts.b ?? 0) / 1000 - 30)).toBeLessThan(1);
    expect(Math.abs((counts.c ?? 0) / 1000 - 60)).toBeLessThan(1);
    expect(resolveFlag(document as unknown as Ruleset, 'split', {})).toMatchObject({ variant: 'a', reason: 'DEFAULT' });
  });

  it('ramps monotonically: every key in at 10% is still in at 20%', () => {
    const [at10, at20] = [ramp(10), ramp(20)];
    const keys = Array.from({ length: 20_000 }, (_, index) => `user-${index}`);
    const inAt10 = keys.filter(key => variantOf(at10, 'ramp', { targetingKey: key }) === 'on');
    const inAt20 = new Set(keys.filter(key => variantOf(at20, 'ramp', { targetingKey: key }) === 'on'));

    expect(inAt10.length).toBeGreaterThan(1500);
    expect(inAt10.every(key => inAt20.has(key))).toBe(true);
    expect(inAt20.size).toBeGreaterThan(inAt10.length);
  });

  it('gives equal documents the same ETag regardless of flag order', () => {
    const a = compile([flag('a'), flag('b')]);
    const b = compile([flag('b'), flag('a')]);
    const c = compileRuleset({ key: 'production', version: 4 }, [flag('a'), flag('b')], noSegments, at);

    expect(rulesetEtag(a)).toBe(rulesetEtag(b));
    expect(rulesetEtag(a)).not.toBe(rulesetEtag(c));
    expect(rulesetEtag(a)).toMatch(/^"[\w-]+"$/u);
  });
});
