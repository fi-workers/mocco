import { describe, expect, it } from 'vitest';

import { applyLogic, LogicError, validateLogic } from './json-logic';
import { parseRuleset } from './ruleset';

const data = { email: 'ada@acme.test', plan: 'pro', seats: 12, tags: ['beta'], org: { tier: 'gold' } };

describe('restricted JsonLogic', () => {
  it.each([
    [{ var: 'org.tier' }, 'gold'],
    [{ var: ['missing', 'fallback'] }, 'fallback'],
    [{ '==': [{ var: 'seats' }, '12'] }, true],
    [{ '!=': [{ var: 'plan' }, 'free'] }, true],
    [{ '<': [10, { var: 'seats' }, 20] }, true],
    [{ '>=': [{ var: 'seats' }, 12] }, true],
    [{ in: ['beta', { var: 'tags' }] }, true],
    [{ in: ['@acme', { var: 'email' }] }, true],
    [{ and: [true, { var: 'plan' }] }, 'pro'],
    [{ or: [false, 0, { var: 'plan' }] }, 'pro'],
    [{ '!': [[]] }, true],
    [{ cat: ['a-', { var: 'plan' }] }, 'a-pro'],
    [{ starts_with: [{ var: 'email' }, 'ada@'] }, true],
    [{ ends_with: [{ var: 'email' }, '.test'] }, true],
    [{ sem_ver: ['2.1.0', '>=', '2.0.0'] }, true],
    [{ if: [{ '==': [{ var: 'plan' }, 'free'] }, 'a', { '==': [{ var: 'plan' }, 'pro'] }, 'b', 'c'] }, 'b'],
  ])('%j → %j', (rule, expected) => {
    expect(applyLogic(rule, data)).toEqual(expected);
  });

  it('evaluates only the branch an if takes', () => {
    expect(applyLogic({ if: [true, 'yes', { unknown_op: [] }] }, data)).toBe('yes');
  });

  it('refuses operators outside the subset', () => {
    expect(validateLogic({ if: [{ merge: [[1], [2]] }, 'a', 'b'] })).toEqual([
      'targeting.if[0]: "merge" isn\'t a supported operator',
    ]);
    expect(() => applyLogic({ map: [[1], { var: '' }] }, data)).toThrow(LogicError);
  });

  it('checks a ruleset before it is used', () => {
    expect(
      parseRuleset({ flags: { a: { state: 'ENABLED', variants: { on: true }, defaultVariant: 'on' } } }),
    ).toMatchObject({ ok: true });
    expect(
      parseRuleset({
        flags: {
          a: { state: 'ON', variants: {}, defaultVariant: 'x', targeting: { reduce: [] }, metadata: { nested: {} } },
        },
      }),
    ).toEqual({
      ok: false,
      errors: [
        'flags.a.state: ENABLED or DISABLED',
        'flags.a.variants: at least one variant',
        'flags.a.defaultVariant: one of the variants, or null',
        'flags.a.metadata: string, number or boolean values only',
        'flags.a.targeting: "reduce" isn\'t a supported operator',
      ],
    });
    expect(parseRuleset(null)).toMatchObject({ ok: false });
  });
});
