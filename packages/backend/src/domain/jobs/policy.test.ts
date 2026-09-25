import { describe, expect, it } from 'vitest';

import { JobPolicy, nextIntervalSlot, retryDelayMs } from '@backend/domain/jobs/policy';

const SECOND = 1000;
const HOUR = 3600 * SECOND;

describe('retryDelayMs', () => {
  it('doubles from 15s per attempt without jitter', () => {
    expect(retryDelayMs(1, () => 0)).toBe(30 * SECOND);
    expect(retryDelayMs(2, () => 0)).toBe(60 * SECOND);
    expect(retryDelayMs(3, () => 0)).toBe(120 * SECOND);
  });

  it('caps the base delay at 6 hours', () => {
    expect(retryDelayMs(20, () => 0)).toBe(6 * HOUR);
    expect(retryDelayMs(1000, () => 0)).toBe(6 * HOUR);
  });

  it('adds at most 25% jitter on top of the base', () => {
    expect(retryDelayMs(1, () => 0.9999)).toBeLessThan(30 * SECOND * (1 + JobPolicy.jitterRatio));
    expect(retryDelayMs(1, () => 0.5)).toBe(30 * SECOND * 1.125);
  });
});

describe('nextIntervalSlot', () => {
  const slot = new Date('2026-09-25T00:00:00.000Z');

  it('is one interval after the slot when the tick is on time', () => {
    expect(nextIntervalSlot(slot, 60, new Date('2026-09-25T00:00:10.000Z')).toISOString()).toBe(
      '2026-09-25T00:01:00.000Z',
    );
  });

  it('skips missed slots instead of replaying a backlog', () => {
    expect(nextIntervalSlot(slot, 60, new Date('2026-09-25T00:05:30.000Z')).toISOString()).toBe(
      '2026-09-25T00:06:00.000Z',
    );
  });

  it('is strictly after now when now falls exactly on a slot', () => {
    expect(nextIntervalSlot(slot, 60, new Date('2026-09-25T00:02:00.000Z')).toISOString()).toBe(
      '2026-09-25T00:03:00.000Z',
    );
  });
});
