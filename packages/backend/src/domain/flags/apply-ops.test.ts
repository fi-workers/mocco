import { describe, expect, it } from 'vitest';

import { applyOps, changesetContentHash } from '@backend/domain/flags/apply-ops';
import { InvalidChangeError } from '@backend/domain/flags/errors';

import type { EnvironmentState } from '@backend/domain/flags/apply-ops';

const state: EnvironmentState = {
  configs: new Map([['checkout', { enabled: false, killed: false, defaultVariant: 'on', offVariant: 'off' }]]),
  variants: new Map([
    ['checkout', ['on', 'off']],
    ['theme', ['light', 'dark']],
  ]),
};

describe('applyOps', () => {
  it('applies ops in order and diffs only the fields that changed', () => {
    const { changed, diff } = applyOps(state, [
      { op: 'set_enabled', flagKey: 'checkout', enabled: true },
      { op: 'add_flag', flagKey: 'theme', defaultVariant: 'light', offVariant: 'light' },
      { op: 'set_default_variant', flagKey: 'theme', variant: 'dark' },
    ]);

    expect(changed.get('checkout')).toMatchObject({ enabled: true });
    expect(changed.get('theme')).toMatchObject({ enabled: false, defaultVariant: 'dark' });
    expect(diff).toEqual([
      { flagKey: 'checkout', field: 'enabled', before: false, after: true },
      { flagKey: 'theme', field: 'enabled', before: null, after: false },
      { flagKey: 'theme', field: 'killed', before: null, after: false },
      { flagKey: 'theme', field: 'defaultVariant', before: null, after: 'dark' },
      { flagKey: 'theme', field: 'offVariant', before: null, after: 'light' },
    ]);
  });

  it('produces no diff for a change back to the current value', () => {
    const { changed, diff } = applyOps(state, [
      { op: 'set_enabled', flagKey: 'checkout', enabled: true },
      { op: 'set_enabled', flagKey: 'checkout', enabled: false },
    ]);

    expect([changed.size, diff]).toEqual([0, []]);
  });

  it.each([
    [{ op: 'set_enabled', flagKey: 'missing', enabled: true }, /not in this environment/u],
    [{ op: 'set_default_variant', flagKey: 'checkout', variant: 'blue' }, /no variant "blue"/u],
    [{ op: 'add_flag', flagKey: 'checkout', defaultVariant: 'on', offVariant: 'off' }, /already in/u],
    [{ op: 'add_flag', flagKey: 'ghost', defaultVariant: 'on', offVariant: 'off' }, /does not exist/u],
  ] as const)('refuses %o', (op, message) => {
    expect(() => applyOps(state, [op])).toThrow(InvalidChangeError);
    expect(() => applyOps(state, [op])).toThrow(message);
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
