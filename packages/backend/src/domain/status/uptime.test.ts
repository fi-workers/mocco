import { MonitorStates } from '@mocco/common/status';
import { describe, expect, it } from 'vitest';

import { bucketOf, histOf, LATENCY_BUCKETS, mergeHists, percentileOf } from '@backend/domain/status/latency-hist';
import {
  DOWN_STATES,
  intervalsIn,
  lengthOf,
  overlapOf,
  stateIntervals,
  unionOf,
  uptimeRatio,
} from '@backend/domain/status/uptime';

import type { MonitorState } from '@mocco/common/status';

const DAY = Date.parse('2026-09-10T00:00:00.000Z');
const H = 3_600_000;
const at = (hours: number) => new Date(DAY + hours * H);
const day = { start: DAY, end: DAY + 24 * H };
const { up, down, recovering, paused, pending } = MonitorStates;
const change = (fromState: MonitorState, toState: MonitorState, hours: number) => ({
  fromState,
  toState,
  at: at(hours),
});

describe('uptimeRatio: 1 - (down - overlap with maintenance) / (observed - maintenance)', () => {
  it.each([
    ['no downtime', { observedMs: 24 * H, downMs: 0, maintenanceMs: 0, downInMaintenanceMs: 0 }, 1],
    ['864 s down in a day', { observedMs: 24 * H, downMs: 864_000, maintenanceMs: 0, downInMaintenanceMs: 0 }, 0.99],
    ['down all day', { observedMs: 24 * H, downMs: 24 * H, maintenanceMs: 0, downInMaintenanceMs: 0 }, 0],
    // An hour down, half of it inside a two-hour window: 1800 s count, over 22 hours.
    [
      'maintenance overlap',
      { observedMs: 24 * H, downMs: H, maintenanceMs: 2 * H, downInMaintenanceMs: H / 2 },
      0.977273,
    ],
    [
      'down only during maintenance',
      { observedMs: 24 * H, downMs: H, maintenanceMs: 2 * H, downInMaintenanceMs: H },
      1,
    ],
    // Created at noon: twelve hours observed, one of them down.
    [
      'a monitor created mid-day',
      { observedMs: 12 * H, downMs: H, maintenanceMs: 0, downInMaintenanceMs: 0 },
      0.916667,
    ],
    ['maintenance all day', { observedMs: 24 * H, downMs: 0, maintenanceMs: 24 * H, downInMaintenanceMs: 0 }, null],
    ['nothing observed', { observedMs: 0, downMs: 0, maintenanceMs: 0, downInMaintenanceMs: 0 }, null],
  ])('%s', (_, input, expected) => {
    expect(uptimeRatio(input)).toBe(expected);
  });
});

describe('stateIntervals', () => {
  it('cuts an outage that spans midnight at the day boundary on both days', () => {
    const changes = [change(up, down, 23.5), change(down, up, 24.5)];
    const first = intervalsIn(stateIntervals(changes, up, day), DOWN_STATES);
    const second = intervalsIn(stateIntervals(changes, up, { start: day.end, end: day.end + 24 * H }), DOWN_STATES);
    expect(lengthOf(first)).toBe(H / 2);
    expect(lengthOf(second)).toBe(H / 2);
  });

  it('counts recovering as down: an outage runs until the next up', () => {
    const changes = [change(up, down, 1), change(down, recovering, 2), change(recovering, up, 3)];
    expect(lengthOf(intervalsIn(stateIntervals(changes, up, day), DOWN_STATES))).toBe(2 * H);
  });

  it('opens the window in the state of the last change before it', () => {
    // Down since the day before, and still down: the whole day.
    expect(lengthOf(intervalsIn(stateIntervals([change(up, down, -5)], down, day), DOWN_STATES))).toBe(24 * H);
  });

  it('uses the first change from-state before it, and the current state without changes', () => {
    expect(stateIntervals([change(pending, up, 6)], up, day)[0]).toEqual({
      state: pending,
      start: DAY,
      end: DAY + 6 * H,
    });
    expect(stateIntervals([], paused, day)).toEqual([{ state: paused, ...day }]);
  });
});

describe('interval sets', () => {
  it('merges overlapping intervals and measures their overlap once', () => {
    const a = [
      { start: 0, end: 10 },
      { start: 5, end: 15 },
      { start: 20, end: 30 },
    ];
    expect(unionOf(a)).toEqual([
      { start: 0, end: 15 },
      { start: 20, end: 30 },
    ]);
    expect(lengthOf(a)).toBe(25);
    expect(overlapOf(a, [{ start: 10, end: 25 }])).toBe(10);
  });
});

describe('latency histograms', () => {
  it('puts latencies in doubling buckets, with an open last bucket', () => {
    expect([0, 7, 8, 15, 16, 100, 1000, 30_000, 10_000_000].map(ms => bucketOf(ms))).toEqual([
      0,
      0,
      1,
      1,
      2,
      4,
      7,
      12,
      LATENCY_BUCKETS - 1,
    ]);
  });

  it('merges bucket by bucket, so percentiles of a sum are those of all the samples', () => {
    const fast = histOf(Array.from({ length: 90 }, () => 50));
    const slow = histOf(Array.from({ length: 10 }, () => 900));
    const merged = mergeHists([fast, slow]);
    expect(merged.reduce((sum, count) => sum + count, 0)).toBe(100);
    // p50 falls among the 50 ms samples (bucket 32–64), p95 among the 900 ms ones (512–1024).
    expect(percentileOf(merged, 0.5)).toBeGreaterThanOrEqual(32);
    expect(percentileOf(merged, 0.5)).toBeLessThan(64);
    expect(percentileOf(merged, 0.95)).toBeGreaterThanOrEqual(512);
    expect(percentileOf(merged, 0.95)).toBeLessThan(1024);
    expect(percentileOf(histOf([]), 0.95)).toBeNull();
  });
});
