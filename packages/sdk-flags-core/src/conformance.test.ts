// A conformance subset of flagd's own evaluator tests (open-feature/flagd
// core/pkg/evaluator: fractional_test.go, json_test.go), run against this package. The
// expected variants are flagd's: a mismatch means Mocco and flagd would bucket or resolve
// the same ruleset differently.
import { describe, expect, it } from 'vitest';

import { ErrorCodes, Reasons, resolveFlag, resolveTyped } from './evaluate';

import type { FlagDefinition, Ruleset } from './ruleset';

const colorVariants = { red: '#FF0000', blue: '#0000FF', green: '#00FF00', yellow: '#FFFF00' };
const quarters = [
  ['red', 25],
  ['blue', 25],
  ['green', 25],
  ['yellow', 25],
];
const onFaas = (fractional: unknown[]) => ({
  if: [{ in: ['@faas.com', { var: ['email'] }] }, { fractional }, null],
});
const color = (targeting: unknown): FlagDefinition => ({
  state: 'ENABLED',
  defaultVariant: 'red',
  variants: colorVariants,
  targeting,
});
const one = (key: string, flag: FlagDefinition): Ruleset => ({ flags: { [key]: flag } });

describe('flagd conformance: fractional', () => {
  const headerColor = color(onFaas([{ cat: [{ var: '$flagd.flagKey' }, { var: 'email' }] }, ...quarters]));
  const seeded = color(onFaas([{ cat: ['my-seed', { var: 'email' }] }, ...quarters]));

  it.each([
    ['headerColor', headerColor, { email: 'rachel@faas.com' }, 'blue', Reasons.targetingMatch],
    ['headerColor', headerColor, { email: 'monica@faas.com' }, 'yellow', Reasons.targetingMatch],
    ['headerColor', headerColor, { email: 'joey@faas.com' }, 'red', Reasons.targetingMatch],
    ['headerColor', headerColor, { email: 'ross@faas.com' }, 'blue', Reasons.targetingMatch],
    ['customSeededHeaderColor', seeded, { email: 'rachel@faas.com' }, 'green', Reasons.targetingMatch],
    ['customSeededHeaderColor', seeded, { email: 'monica@faas.com' }, 'red', Reasons.targetingMatch],
    ['customSeededHeaderColor', seeded, { email: 'joey@faas.com' }, 'blue', Reasons.targetingMatch],
    ['customSeededHeaderColor', seeded, { email: 'ross@faas.com' }, 'green', Reasons.targetingMatch],
    [
      'footerColor',
      color(onFaas([{ var: 'email' }, ...quarters])),
      { email: 'ross@faas.com' },
      'red',
      Reasons.targetingMatch,
    ],
    [
      'headerColor',
      color(onFaas(['email', ['red', 50], ['blue', 25], ['green', 25]])),
      { email: 'test4@faas.com' },
      'green',
      Reasons.targetingMatch,
    ],
    ['headerColor', color({ fractional: [{ var: 'email' }, ...quarters] }), {}, 'red', Reasons.default],
    [
      'headerColor',
      color({ fractional: [{ var: 'email' }, ['red', 25], ['blue', 25]] }),
      { email: 'foo@foo.com' },
      'blue',
      Reasons.targetingMatch,
    ],
    [
      'headerColor',
      color({ fractional: [{ var: 'email' }, ['red'], ['blue']] }),
      { email: 'foo@foo.com' },
      'blue',
      Reasons.targetingMatch,
    ],
    [
      'headerColor',
      color({
        fractional: [
          ['blue', 50],
          ['green', 50],
        ],
      }),
      { targetingKey: 'foo@foo.com' },
      'green',
      Reasons.targetingMatch,
    ],
    [
      'headerColor',
      color({ fractional: [{ var: 'email' }, ['red', 50], ['blue', 50]] }),
      { targetingKey: 'foo@foo.com' },
      'blue',
      Reasons.targetingMatch,
    ],
    [
      'headerColor',
      color({
        fractional: [
          ['blue', 50],
          ['green', 50],
        ],
      }),
      { targetingKey: null },
      'red',
      Reasons.default,
    ],
    [
      'headerColor',
      color({
        fractional: [
          ['blue', 50],
          ['green', 50],
        ],
      }),
      {},
      'red',
      Reasons.default,
    ],
    [
      'headerColor',
      color({
        fractional: [
          ['blue', 50],
          ['green', 50],
        ],
      }),
      { targetingKey: '' },
      'red',
      Reasons.default,
    ],
    ['headerColor', color({ fractional: [['blue', 1]] }), { targetingKey: 'any-user' }, 'blue', Reasons.targetingMatch],
    [
      'headerColor',
      color({ fractional: [{ var: 'email' }, ['green', 100]] }),
      { email: 'any@user.com' },
      'green',
      Reasons.targetingMatch,
    ],
    [
      'headerColor',
      color({ fractional: [['yellow']] }),
      { targetingKey: 'any-user' },
      'yellow',
      Reasons.targetingMatch,
    ],
  ] as const)('%s with %j → %s', (key, flag, context, variant, reason) => {
    const resolution = resolveFlag(one(key, flag), key, context);

    expect(resolution).toMatchObject({ variant, reason, value: colorVariants[variant] });
  });
});

describe('flagd conformance: resolution', () => {
  const ruleset: Ruleset = {
    flags: {
      staticBool: { state: 'ENABLED', variants: { on: true, off: false }, defaultVariant: 'on' },
      dynamicBool: {
        state: 'ENABLED',
        variants: { on: true, off: false },
        defaultVariant: 'off',
        targeting: { if: [{ '==': [{ var: 'color' }, 'yellow'] }, 'on', 'off'] },
      },
      staticObject: { state: 'ENABLED', variants: { obj: { abc: 'def' } }, defaultVariant: 'obj' },
      disabled: { state: 'DISABLED', variants: { on: true, off: false }, defaultVariant: 'on' },
      nullDefault: {
        state: 'ENABLED',
        variants: { on: true, off: false },
        defaultVariant: null,
        targeting: { if: [{ '==': [{ var: ['key'] }, 'value'] }, 'on'] },
      },
      ambientKey: {
        state: 'ENABLED',
        variants: { true: true, false: false },
        defaultVariant: 'false',
        targeting: { '==': [{ var: '$flagd.flagKey' }, 'ambientKey'] },
      },
      ambientTime: {
        state: 'ENABLED',
        variants: { true: true, false: false },
        defaultVariant: 'false',
        targeting: { '<': [1_696_904_426, { var: '$flagd.timestamp' }] },
      },
      missingVariant: {
        state: 'ENABLED',
        variants: { foo: true, bar: false },
        defaultVariant: 'foo',
        targeting: { if: [true, 'buz', 'baz'] },
      },
      nullFallback: {
        state: 'ENABLED',
        variants: { foo: true, bar: false },
        defaultVariant: 'foo',
        targeting: { if: [true, null, 'baz'] },
      },
      matchBoolean: {
        state: 'ENABLED',
        variants: { false: 1, true: 2 },
        defaultVariant: 'false',
        targeting: { if: [true, true, false] },
      },
    },
  };

  it('resolves booleans like flagd: static, targeting, type mismatch, missing, disabled', () => {
    const results = [
      resolveTyped(ruleset, 'staticBool', 'boolean', false),
      resolveTyped(ruleset, 'dynamicBool', 'boolean', false, { color: 'yellow' }),
      resolveTyped(ruleset, 'staticObject', 'boolean', true),
      resolveTyped(ruleset, 'missing', 'boolean', true),
      resolveTyped(ruleset, 'disabled', 'boolean', false),
    ];

    expect(results.map(({ value, reason, errorCode }) => [value, reason, errorCode])).toEqual([
      [true, Reasons.static, undefined],
      [true, Reasons.targetingMatch, undefined],
      [true, Reasons.error, ErrorCodes.typeMismatch],
      [true, Reasons.error, ErrorCodes.flagNotFound],
      [false, Reasons.disabled, undefined],
    ]);
  });

  it('serves the caller default when no default variant is reached', () => {
    expect(resolveTyped(ruleset, 'nullDefault', 'boolean', false)).toMatchObject({
      value: false,
      reason: Reasons.default,
    });
    expect(resolveTyped(ruleset, 'nullDefault', 'boolean', false, { key: 'value' })).toMatchObject({
      value: true,
      variant: 'on',
      reason: Reasons.targetingMatch,
    });
  });

  it('puts $flagd.flagKey and $flagd.timestamp in the context', () => {
    expect(resolveFlag(ruleset, 'ambientKey')).toMatchObject({ value: true, variant: 'true' });
    expect(resolveFlag(ruleset, 'ambientTime')).toMatchObject({ value: true, reason: Reasons.targetingMatch });
  });

  it('errors on an unknown variant, falls back on null, and stringifies boolean results', () => {
    expect(resolveFlag(ruleset, 'missingVariant')).toMatchObject({
      reason: Reasons.error,
      errorCode: ErrorCodes.general,
    });
    expect(resolveFlag(ruleset, 'nullFallback')).toMatchObject({
      value: true,
      variant: 'foo',
      reason: Reasons.default,
    });
    expect(resolveTyped(ruleset, 'matchBoolean', 'number', 0)).toMatchObject({
      value: 2,
      variant: 'true',
      reason: Reasons.targetingMatch,
    });
  });
});
