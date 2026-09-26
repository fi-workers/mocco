import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { JobPolicy, JobTiming, nextIntervalSlot, retryDelayMs } from '@backend/domain/jobs/policy';

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

describe('JobTiming', () => {
  it('keeps visibility > function max duration > max tick budget >= default tick budget', () => {
    // A lock must outlive the function that holds it, or a live run gets reclaimed; the
    // tick must stop claiming before the function is killed.
    expect(JobTiming.visibilityMs).toBeGreaterThan(JobTiming.functionMaxDurationMs);
    expect(JobTiming.functionMaxDurationMs).toBeGreaterThan(JobTiming.maxTickBudgetMs);
    expect(JobTiming.maxTickBudgetMs).toBeGreaterThanOrEqual(JobTiming.defaultTickBudgetMs);
  });

  it('matches the maxDuration the ext route handler exports', async () => {
    // Next reads `maxDuration` statically, so route.ts holds a literal; this keeps it in sync.
    const route = await readFile(
      fileURLToPath(new URL('../../../../frontend/src/app/api/ext/[[...route]]/route.ts', import.meta.url)),
      'utf8',
    );
    const match = /export const maxDuration = (\d+);/.exec(route);
    expect(Number(match?.[1]) * 1000).toBe(JobTiming.functionMaxDurationMs);
  });
});
