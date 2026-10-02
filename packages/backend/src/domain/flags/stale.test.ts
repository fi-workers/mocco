import { StaleKinds } from '@mocco/common/flags';
import { describe, expect, it } from 'vitest';

import { detectStale } from '@backend/domain/flags/stale';

import type { StaleConfig, StaleInputs } from '@backend/domain/flags/stale';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-02T00:00:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
const flag = { id: 'f1', key: 'checkout', lifecycle: 'temporary' as const, createdAt: daysAgo(60) };

const config = (environmentId: string, overrides: Partial<StaleConfig> = {}): StaleConfig => ({
  flagId: 'f1',
  environmentId,
  enabled: true,
  killed: false,
  defaultVariant: 'on',
  rules: [],
  rollout: null,
  changedAt: daysAgo(45),
  ...overrides,
});

/** The kinds found for `flag` with these configs in environments a and b, evaluated yesterday. */
const kinds = (configs: StaleConfig[], overrides: Partial<StaleInputs> = {}) =>
  detectStale(
    {
      flags: [flag],
      configs,
      environmentIds: ['a', 'b'],
      lastSeen: new Map([['checkout', daysAgo(1)]]),
      ...overrides,
    },
    now,
    30,
  ).map(finding => `${finding.kind}:${finding.servedVariant ?? '-'}`);

describe('detectStale', () => {
  it('reports a flag serving one variant to everyone everywhere for the stale period', () => {
    expect(kinds([config('a'), config('b')])).toEqual([`${StaleKinds.fullyRolledOut}:on`]);
    // A rollout with all the weight on one variant counts; so does a snapshot that is gone.
    const rollout = [
      { variant: 'on', weight: 100 },
      { variant: 'off', weight: 0 },
    ];
    expect(kinds([config('a', { rollout }), config('b', { changedAt: null })])).toEqual([
      `${StaleKinds.fullyRolledOut}:on`,
    ]);
  });

  it('does not report a flag whose callers can still get different answers', () => {
    const cases: StaleConfig[][] = [
      [config('a'), config('b', { defaultVariant: 'off' })],
      [config('a'), config('b', { enabled: false })],
      [config('a'), config('b', { killed: true })],
      [config('a'), config('b', { rules: [{ clauses: [], serve: { variant: 'off' } }] })],
      [
        config('a'),
        config('b', {
          rollout: [
            { variant: 'on', weight: 50 },
            { variant: 'off', weight: 50 },
          ],
        }),
      ],
      [config('a'), config('b', { changedAt: daysAgo(10) })],
      [config('a')],
    ];
    expect(cases.map(configs => kinds(configs))).toEqual(cases.map(() => []));
  });

  it('reports unused and never-evaluated flags, and exempts young and permanent ones', () => {
    expect(kinds([], { lastSeen: new Map([['checkout', daysAgo(31)]]) })).toEqual([`${StaleKinds.unused}:-`]);
    expect(kinds([], { lastSeen: new Map() })).toEqual([`${StaleKinds.neverEvaluated}:-`]);
    expect(kinds([], { lastSeen: new Map(), flags: [{ ...flag, createdAt: daysAgo(5) }] })).toEqual([]);
    expect(
      kinds([config('a'), config('b')], { lastSeen: new Map(), flags: [{ ...flag, lifecycle: 'permanent' }] }),
    ).toEqual([]);
  });
});
