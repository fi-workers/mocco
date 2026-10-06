// TLS expiry warnings (#151, status page spec "Consensus and state machine"): a separate,
// non-outage signal. An https check reports its certificate's `tlsExpiresAt`; when a round closes,
// the evaluator asks `tlsWarningOf` whether the remaining time crossed a threshold it hasn't
// alerted on yet, and stores the answer in the monitor's `tls_warned_days`. Pure.
//
// The thresholds are the monitor's `tlsWarnDays` and each of `TLS_WARN_STEPS_DAYS` below it, so a
// monitor warned at 14 days warns again at 7, 3 and 1. Each fires once: `tls_warned_days` holds
// the lowest threshold alerted. A renewed certificate whose remaining time rises above a threshold
// re-arms it, without a warning; an expired one fails the handshake instead (an outage, not this).
import { TLS_WARN_STEPS_DAYS } from '@mocco/common/status';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TlsWarning {
  /** The threshold crossed, in days. */
  thresholdDays: number;
  /** Whole days left, rounded down. */
  daysLeft: number;
  expiresAt: Date;
}

/** The monitor's thresholds, highest first: `warnDays` and the steps below it. */
export function tlsThresholds(warnDays: number): number[] {
  return [warnDays, ...TLS_WARN_STEPS_DAYS.filter(step => step < warnDays)];
}

/**
 * The warning a certificate expiring at `expiresAt` raises now, if any, and the `warnedDays` to
 * store. The crossed threshold is the lowest one the remaining time is under. It warns when that
 * is below the lowest already warned (or none was); several thresholds crossed at once (a new
 * monitor on a certificate with two days left) are one warning, at the lowest.
 */
export function tlsWarningOf(input: { warnDays: number; expiresAt: Date; now: Date; warnedDays: number | null }): {
  warnedDays: number | null;
  warning?: TlsWarning;
} {
  const remainingMs = input.expiresAt.getTime() - input.now.getTime();
  const crossed = tlsThresholds(input.warnDays).filter(days => remainingMs < days * DAY_MS);
  const lowest = crossed.at(-1);
  if (lowest === undefined) {
    // Above every threshold (a renewed certificate): all of them are armed again.
    return { warnedDays: null };
  }
  if (input.warnedDays !== null && lowest >= input.warnedDays) {
    // Already warned at this threshold or a lower one; a renewal that climbed above some re-arms them.
    return { warnedDays: lowest };
  }
  return {
    warnedDays: lowest,
    warning: {
      thresholdDays: lowest,
      daysLeft: Math.max(0, Math.floor(remainingMs / DAY_MS)),
      expiresAt: input.expiresAt,
    },
  };
}

/** The certificate a round saw: the earliest expiry any location reported, or undefined. */
export function earliestExpiry(reports: readonly { tlsExpiresAt: Date | null }[]): Date | undefined {
  return reports.reduce<Date | undefined>((earliest, report) => {
    const at = report.tlsExpiresAt;
    return at !== null && (earliest === undefined || at < earliest) ? at : earliest;
  }, undefined);
}
