import { describe, expect, it } from 'vitest';

import { earliestExpiry, tlsThresholds, tlsWarningOf } from '@backend/domain/status/tls-expiry';

const NOW = new Date('2026-10-06T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

describe('tlsThresholds', () => {
  it.each<[number, number[]]>([
    [14, [14, 7, 3, 1]],
    [7, [7, 3, 1]],
    [5, [5, 3, 1]],
    [3, [3, 1]],
    [1, [1]],
  ])('warns at %i days and the steps below it', (warnDays, thresholds) => {
    expect(tlsThresholds(warnDays)).toEqual(thresholds);
  });
});

/** Feed one round's remaining days at a time; the threshold each round warned at, or null. */
const warnings = (daysLeft: number[], warnDays = 14) => {
  let warnedDays: number | null = null;
  return daysLeft.map(days => {
    const next = tlsWarningOf({ warnDays, expiresAt: inDays(days), now: NOW, warnedDays });
    ({ warnedDays } = next);
    return next.warning?.thresholdDays ?? null;
  });
};

describe('tlsWarningOf', () => {
  it.each<[string, number[], (number | null)[]]>([
    ['nothing above the first threshold', [30, 20, 14], [null, null, null]],
    [
      'once at each threshold as the days run down',
      [15, 13.5, 13, 8, 6.9, 6, 2.5, 2, 0.5, 0.2],
      [null, 14, null, null, 7, null, 3, null, 1, null],
    ],
    ['several crossed at once are one warning, at the lowest', [2, 1.5], [3, null]],
    ['a renewal re-arms, and the next crossing warns again', [13, 90, 13], [14, null, 14]],
    ['a renewal still inside the window re-arms only the lower ones', [2, 10, 9, 2], [3, null, null, 3]],
  ])('%s', (_name, daysLeft, warned) => {
    expect(warnings(daysLeft)).toEqual(warned);
  });

  it('reports the whole days left and the certificate', () => {
    expect(tlsWarningOf({ warnDays: 14, expiresAt: inDays(13.7), now: NOW, warnedDays: null })).toEqual({
      warnedDays: 14,
      warning: { thresholdDays: 14, daysLeft: 13, expiresAt: inDays(13.7) },
    });
  });
});

describe('earliestExpiry', () => {
  it('takes the earliest certificate any location saw', () => {
    expect(earliestExpiry([{ tlsExpiresAt: inDays(9) }, { tlsExpiresAt: null }, { tlsExpiresAt: inDays(4) }])).toEqual(
      inDays(4),
    );
    expect(earliestExpiry([{ tlsExpiresAt: null }])).toBeUndefined();
  });
});
