import { describe, expect, it } from 'vitest';

import { applyOps, changesetContentHash } from '@backend/domain/flags/apply-ops';
import { InvalidChangeError } from '@backend/domain/flags/errors';

import type { EnvironmentState } from '@backend/domain/flags/apply-ops';
import type { ChangeOp, Rule } from '@mocco/common/flags';

const config = { enabled: false, killed: false, defaultVariant: 'on', offVariant: 'off', rules: [], rollout: null };
const beta = { name: 'Beta testers', includedKeys: ['u1'], excludedKeys: [], rules: [] };
const state: EnvironmentState = {
  configs: new Map([['checkout', config]]),
  segments: new Map([['beta', beta]]),
  variants: new Map([
    ['checkout', ['on', 'off']],
    ['theme', ['light', 'dark']],
  ]),
};
const proRule: Rule = {
  clauses: [
    { attribute: 'plan', op: 'in', values: ['pro'] },
    { segment: 'beta', negate: false },
  ],
  serve: { variant: 'on' },
};

describe('applyOps', () => {
  it('applies ops in order and diffs only the fields that changed', () => {
    const { changed, diff } = applyOps(state, [
      { op: 'set_enabled', flagKey: 'checkout', enabled: true },
      { op: 'add_flag', flagKey: 'theme', defaultVariant: 'light', offVariant: 'light' },
      { op: 'set_default_variant', flagKey: 'theme', variant: 'dark' },
    ]);

    expect(changed.get('checkout')).toMatchObject({ enabled: true });
    expect(changed.get('theme')).toMatchObject({ enabled: false, defaultVariant: 'dark', rules: [] });
    expect(diff).toEqual([
      { subject: 'flag', key: 'checkout', field: 'enabled', before: false, after: true },
      { subject: 'flag', key: 'theme', field: 'enabled', before: null, after: false },
      { subject: 'flag', key: 'theme', field: 'killed', before: null, after: false },
      { subject: 'flag', key: 'theme', field: 'defaultVariant', before: null, after: 'dark' },
      { subject: 'flag', key: 'theme', field: 'offVariant', before: null, after: 'light' },
      { subject: 'flag', key: 'theme', field: 'rules', before: null, after: [] },
    ]);
  });

  it('sets rules, a rollout and segments, in one changeset', () => {
    const rollout = [
      { variant: 'on', weight: 10 },
      { variant: 'off', weight: 90 },
    ];
    const { changed, changedSegments, diff } = applyOps(state, [
      { op: 'set_segment', segmentKey: 'staff', segment: { ...beta, name: 'Staff', includedKeys: ['u9'] } },
      {
        op: 'set_rules',
        flagKey: 'checkout',
        rules: [proRule, { clauses: [{ segment: 'staff', negate: false }], serve: { rollout } }],
      },
      { op: 'set_rollout', flagKey: 'checkout', rollout },
    ]);

    expect(changed.get('checkout')).toMatchObject({ rollout, rules: [proRule, expect.anything()] });
    expect(changedSegments.get('staff')).toMatchObject({ name: 'Staff' });
    expect(diff.map(entry => `${entry.subject}:${entry.key}.${entry.field}`)).toEqual([
      'flag:checkout.rules',
      'flag:checkout.rollout',
      'segment:staff.name',
      'segment:staff.includedKeys',
      'segment:staff.excludedKeys',
      'segment:staff.rules',
    ]);
  });

  it('produces no diff for a change back to the current value', () => {
    const { changed, diff } = applyOps(state, [
      { op: 'set_enabled', flagKey: 'checkout', enabled: true },
      { op: 'set_enabled', flagKey: 'checkout', enabled: false },
      { op: 'set_segment', segmentKey: 'beta', segment: beta },
    ]);

    expect([changed.size, diff]).toEqual([0, []]);
  });

  it.each([
    [{ op: 'set_enabled', flagKey: 'missing', enabled: true }, /not in this environment/u],
    [{ op: 'set_default_variant', flagKey: 'checkout', variant: 'blue' }, /no variant "blue"/u],
    [{ op: 'add_flag', flagKey: 'checkout', defaultVariant: 'on', offVariant: 'off' }, /already in/u],
    [{ op: 'add_flag', flagKey: 'ghost', defaultVariant: 'on', offVariant: 'off' }, /does not exist/u],
    [{ op: 'set_rollout', flagKey: 'checkout', rollout: [{ variant: 'blue', weight: 1 }] }, /no variant "blue"/u],
    [
      { op: 'set_rules', flagKey: 'checkout', rules: [{ ...proRule, serve: { variant: 'blue' } }] },
      /no variant "blue"/u,
    ],
    [
      {
        op: 'set_rules',
        flagKey: 'checkout',
        rules: [{ clauses: [{ segment: 'nobody', negate: false }], serve: { variant: 'on' } }],
      },
      /Segment "nobody" is not in this environment/u,
    ],
    [{ op: 'delete_segment', segmentKey: 'nobody' }, /Segment "nobody" is not in this environment/u],
  ] as [ChangeOp, RegExp][])('refuses %o', (op, message) => {
    expect(() => applyOps(state, [op])).toThrow(InvalidChangeError);
    expect(() => applyOps(state, [op])).toThrow(message);
  });

  it("refuses to delete a segment a flag's rules still use", () => {
    const used: EnvironmentState = { ...state, configs: new Map([['checkout', { ...config, rules: [proRule] }]]) };

    expect(() => applyOps(used, [{ op: 'delete_segment', segmentKey: 'beta' }])).toThrow(/used by flag "checkout"/u);
    expect(applyOps(state, [{ op: 'delete_segment', segmentKey: 'beta' }]).deletedSegments).toEqual(new Set(['beta']));
  });
});

describe('changesetContentHash', () => {
  it('binds the environment, the base version and the ops', () => {
    const ops = [{ op: 'set_enabled', flagKey: 'checkout', enabled: true }] as const;
    const hash = changesetContentHash('env-1', 4, ops);

    expect(changesetContentHash('env-1', 4, [{ enabled: true, flagKey: 'checkout', op: 'set_enabled' }])).toBe(hash);
    expect(changesetContentHash('env-2', 4, ops)).not.toBe(hash);
    expect(changesetContentHash('env-1', 5, ops)).not.toBe(hash);
  });
});
