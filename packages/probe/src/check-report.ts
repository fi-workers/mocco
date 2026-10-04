// What one check produces: a protocol result without the lease it answers.
import { CheckOutcomes, type ProbeResult } from '@mocco/common/status';

import { describeError, errorKindOf } from './errors';

import type { Resolver } from './resolve';

export type CheckReport = Omit<ProbeResult, 'leaseId' | 'monitorId' | 'roundAt'>;
export type Timings = NonNullable<CheckReport['timings']>;

/** What every check needs from the agent. */
export interface CheckContext {
  /** Resolves names under the location's address policy. */
  resolver: Resolver;
  /** Sent as `User-Agent` by HTTP checks. */
  userAgent: string;
  now: () => Date;
}

/** A failed check, its kind and detail read from the error. */
export const failedReport = (error: unknown, extra: Partial<CheckReport> = {}): CheckReport => ({
  outcome: CheckOutcomes.fail,
  errorKind: errorKindOf(error),
  detail: describeError(error),
  ...extra,
});

/** Milliseconds, rounded to an integer as `latencyMs` must be. */
export const wholeMs = (ms: number): number => Math.max(0, Math.round(ms));

/** Timings rounded to a tenth of a millisecond, without the phases a check didn't have. */
export const roundTimings = (timings: Timings): Timings | undefined => {
  const entries = Object.entries(timings).filter(([, ms]) => typeof ms === 'number');
  return entries.length === 0
    ? undefined
    : Object.fromEntries(entries.map(([phase, ms]) => [phase, Math.round(Math.max(0, ms) * 10) / 10]));
};
