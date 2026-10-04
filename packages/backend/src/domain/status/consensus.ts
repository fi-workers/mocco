// Consensus and the monitor state machine (#150, status page spec "Consensus and state machine").
// Pure: the verdict evaluator feeds it one closed round at a time and writes what it returns.
//
// A round's verdict comes from the locations that reported; a silent location is `no_data` and
// never counts either way. The state machine moves only on `ok`, `degraded` and `fail` verdicts;
// `unknown` (no quorum, or nobody reported) leaves the state and its streaks as they were.
import { CheckOutcomes, MonitorStates, QuorumModes, RoundVerdicts } from '@mocco/common/status';

import type { CheckOutcome, MonitorState, QuorumMode, RoundVerdict } from '@mocco/common/status';

export interface LocationReport {
  outcome: CheckOutcome;
  latencyMs: number | null;
}

export interface RoundTally {
  verdict: RoundVerdict;
  okCount: number;
  failCount: number;
  noDataCount: number;
  p50LatencyMs: number | null;
}

/** How many reporting locations must agree. Never below one, so a single location is a quorum of one. */
export function quorumFor(mode: QuorumMode, reporting: number): number {
  if (mode === QuorumModes.any) {
    return 1;
  }
  if (mode === QuorumModes.all) {
    return Math.max(1, reporting);
  }
  return Math.max(1, Math.ceil(reporting / 2));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/**
 * The verdict of one round. `fail` when at least a quorum of the reporting locations failed
 * (checked first, so a tie under `majority` is a failure); `ok` when a quorum passed, or
 * `degraded` when a quorum of passing checks was slower than the threshold; `unknown` otherwise,
 * including when nobody reported. `assigned` counts the locations that owed a result: those
 * that sent none are `no_data`.
 */
export function tallyRound(
  reports: readonly LocationReport[],
  opts: { assigned: number; quorumMode: QuorumMode; latencyThresholdMs: number | undefined },
): RoundTally {
  const passed = reports.filter(report => report.outcome === CheckOutcomes.ok);
  const failCount = reports.filter(report => report.outcome === CheckOutcomes.fail).length;
  const okCount = passed.length;
  const reporting = okCount + failCount;
  const noDataCount = Math.max(0, opts.assigned - reporting);
  const p50LatencyMs = median(passed.flatMap(report => (report.latencyMs === null ? [] : [report.latencyMs])));
  const tally = { okCount, failCount, noDataCount, p50LatencyMs };
  if (reporting === 0) {
    return { verdict: RoundVerdicts.unknown, ...tally };
  }
  const quorum = quorumFor(opts.quorumMode, reporting);
  if (failCount >= quorum) {
    return { verdict: RoundVerdicts.fail, ...tally };
  }
  if (okCount < quorum) {
    return { verdict: RoundVerdicts.unknown, ...tally };
  }
  const threshold = opts.latencyThresholdMs;
  const slow =
    threshold === undefined
      ? 0
      : passed.filter(report => report.latencyMs !== null && report.latencyMs > threshold).length;
  return { verdict: slow >= quorum ? RoundVerdicts.degraded : RoundVerdicts.ok, ...tally };
}

export interface MachineState {
  state: MonitorState;
  consecutiveFails: number;
  consecutiveOks: number;
}

export interface Transition extends MachineState {
  /** Check again at once instead of waiting an interval: the monitor just became suspect. */
  recheck: boolean;
}

/** The state a passing verdict settles on. */
const settled = (verdict: RoundVerdict): MonitorState =>
  verdict === RoundVerdicts.degraded ? MonitorStates.degraded : MonitorStates.up;

/**
 * The next state after one closed round.
 *
 * - A failing round from `pending`, `up`, `degraded` or `suspect` starts or extends a fail
 *   streak: the monitor is `suspect` (with an immediate recheck) until `confirmations` rounds in a
 *   row have failed, then `down`. With `confirmations = 1` the first failure is `down`.
 * - A passing round ends a fail streak. From `pending`, `up`, `degraded` or `suspect` it settles at
 *   once (`up`, or `degraded` for a slow round). From `down` or `recovering` it is `recovering` until
 *   `recoveryConfirmations` rounds in a row have passed, then it settles.
 * - A failing round while `recovering` is `down` again. An `unknown` round changes nothing.
 * - A `paused` monitor isn't evaluated; it is returned unchanged.
 */
export function nextState(
  current: MachineState,
  verdict: RoundVerdict,
  opts: { confirmations: number; recoveryConfirmations: number },
): Transition {
  const unchanged = { ...current, recheck: false };
  if (current.state === MonitorStates.paused || verdict === RoundVerdicts.unknown) {
    return unchanged;
  }
  const isOutage = current.state === MonitorStates.down || current.state === MonitorStates.recovering;
  if (verdict === RoundVerdicts.fail) {
    const consecutiveFails = current.consecutiveFails + 1;
    if (isOutage || consecutiveFails >= opts.confirmations) {
      return { state: MonitorStates.down, consecutiveFails, consecutiveOks: 0, recheck: false };
    }
    return { state: MonitorStates.suspect, consecutiveFails, consecutiveOks: 0, recheck: true };
  }
  const consecutiveOks = current.consecutiveOks + 1;
  if (isOutage && consecutiveOks < opts.recoveryConfirmations) {
    return { state: MonitorStates.recovering, consecutiveFails: 0, consecutiveOks, recheck: false };
  }
  return { state: settled(verdict), consecutiveFails: 0, consecutiveOks, recheck: false };
}
