// Uptime math over time intervals (#152). Downtime comes from a monitor's state changes, not from
// counting rounds: an outage runs from `down` to the next state that isn't `down` or
// `recovering`, so time between rounds is counted, and a round with an `unknown` verdict (which
// never changes the state) can't add or remove any. Pure; times are epoch milliseconds, UTC.
import { MonitorStates } from '@mocco/common/status';

import type { MonitorState } from '@mocco/common/status';

/** A half-open span of time, `[start, end)`. */
export interface Interval {
  start: number;
  end: number;
}

export interface StateInterval extends Interval {
  state: MonitorState;
}

/** The states during which a monitor counts as down: an outage lasts until the next `up`. */
export const DOWN_STATES: ReadonlySet<MonitorState> = new Set([MonitorStates.down, MonitorStates.recovering]);

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** The part of `interval` inside `window`, or undefined when they don't overlap. */
export function clip(interval: Interval, window: Interval): Interval | undefined {
  const start = Math.max(interval.start, window.start);
  const end = Math.min(interval.end, window.end);
  return end > start ? { start, end } : undefined;
}

/** The intervals merged into disjoint ones, in order. */
export function unionOf(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(interval => interval.end > interval.start).toSorted((a, b) => a.start - b.start);
  return sorted.reduce<Interval[]>((merged, interval) => {
    const last = merged.at(-1);
    if (last !== undefined && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      return merged;
    }
    merged.push({ ...interval });
    return merged;
  }, []);
}

/** The length of the union, in milliseconds. */
export const lengthOf = (intervals: readonly Interval[]): number =>
  unionOf(intervals).reduce((sum, interval) => sum + interval.end - interval.start, 0);

/** The length of the time both sets of intervals cover, in milliseconds. */
export function overlapOf(a: readonly Interval[], b: readonly Interval[]): number {
  // Both unions are disjoint, so the pairwise overlaps never count a moment twice.
  const right = unionOf(b);
  return unionOf(a).reduce(
    (sum, left) =>
      sum +
      right.reduce((inner, interval) => {
        const part = clip(left, interval);
        return part === undefined ? inner : inner + part.end - part.start;
      }, 0),
    0,
  );
}

/** Everything in `intervals` clipped to `window`. */
export const clipAll = (intervals: readonly Interval[], window: Interval): Interval[] =>
  intervals.flatMap(interval => clip(interval, window) ?? []);

/**
 * A monitor's states over `window`, from its changes in time order. `changes` must include the
 * last change before the window (if any), so the state the window opens with is known; before a
 * monitor's first change it was in that change's `fromState`, and a monitor with no changes at
 * all has been in `currentState` all along.
 */
export function stateIntervals(
  changes: readonly { fromState: MonitorState; toState: MonitorState; at: Date }[],
  currentState: MonitorState,
  window: Interval,
): StateInterval[] {
  const sorted = changes.toSorted((a, b) => a.at.getTime() - b.at.getTime());
  const opening: StateInterval = { state: sorted[0]?.fromState ?? currentState, start: -Infinity, end: Infinity };
  // Each change ends the span before it and opens the next one, which lasts until further notice.
  const spans = sorted.reduce<StateInterval[]>(
    (done, change) => {
      const at = change.at.getTime();
      const last = done.at(-1) ?? opening;
      last.end = at;
      done.push({ state: change.toState, start: at, end: Infinity });
      return done;
    },
    [opening],
  );
  return spans.flatMap(span => {
    const part = clip(span, window);
    return part === undefined ? [] : [{ state: span.state, ...part }];
  });
}

/** The intervals spent in any of `states`. */
export const intervalsIn = (spans: readonly StateInterval[], states: ReadonlySet<MonitorState>): Interval[] =>
  spans.filter(span => states.has(span.state)).map(({ start, end }) => ({ start, end }));

/**
 * `uptime = 1 - (down - overlap_with_maintenance) / (observed - maintenance)`, rounded to six
 * places (the column's scale). `observed` is the part of the day the monitor was watched: from
 * the day's start or its creation, to the day's end or now, without paused time. Null when
 * maintenance covered all of it, or nothing was observed: there is no uptime to report.
 */
export function uptimeRatio(input: {
  observedMs: number;
  downMs: number;
  maintenanceMs: number;
  downInMaintenanceMs: number;
}): number | null {
  const denominator = input.observedMs - input.maintenanceMs;
  if (denominator <= 0) {
    return null;
  }
  const ratio = 1 - (input.downMs - input.downInMaintenanceMs) / denominator;
  return Math.round(Math.min(Math.max(ratio, 0), 1) * 1_000_000) / 1_000_000;
}

/** Milliseconds to whole seconds, as stored. */
export const toSeconds = (ms: number): number => Math.round(ms / 1000);
