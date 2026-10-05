// The verdict evaluator (#150): closes monitor rounds, decides them with `consensus.ts`, and moves
// each monitor's state and schedule. It runs as the per-minute `status.evaluate` job and, for the
// monitors a probe just reported on, right after ingest.
//
// A round is the monitor's `next_round_at`. It closes once every enabled location assigned to the
// monitor has reported, or once its deadline (the round, the check's timeout and the result grace,
// the same moment its leases expire) has passed; a location that sent nothing is `no_data`. Each
// close is one transaction under the monitor's advisory lock, which pause and resume take too:
// the verdict, the new state and streaks, the next round, and a state change row when the state
// moved. The round is re-read under the lock, so two evaluators can't close it twice.
//
// During a deploy watch (DeployWatchService) a round that starts before `watch_until` is followed
// by one `watch_interval_s` later; the first round at or past it clears the watch, and the
// monitor's own interval resumes.
//
// A heartbeat (#153) has no rounds: its `next_round_at` is its silence deadline, and when it passes
// the evaluator takes the heartbeat down (heartbeat.ts) under the same lock, with no verdict row.
//
// After a change commits, the `onStateChange` port (bound in compose.ts to the
// MonitorTransitionService) handles what it means for pages, incidents and alerts; the
// evaluator knows nothing of those.
import { isProbeSpec, MonitorKinds, MonitorStates, RoundVerdicts } from '@mocco/common/status';

import { nextState, tallyRound } from '@backend/domain/status/consensus';
import { applyHeartbeatVerdict, HeartbeatCauses } from '@backend/domain/status/heartbeat';
import { leaseExpiry } from '@backend/domain/status/ProbeService';
import { CheckResultRepo } from '@backend/domain/status/repos/check-result.repo';
import { MonitorLocationRepo } from '@backend/domain/status/repos/monitor-location.repo';
import { MonitorStateChangeRepo } from '@backend/domain/status/repos/monitor-state-change.repo';
import { MonitorRepo } from '@backend/domain/status/repos/monitor.repo';
import { RoundVerdictRepo } from '@backend/domain/status/repos/round-verdict.repo';
import { utcDayOf } from '@backend/infra/db/day-partitions';

import type { MonitorStateChangeRow } from '@backend/domain/status/repos/monitor-state-change.repo';
import type { MonitorRow } from '@backend/domain/status/repos/monitor.repo';
import type { Db } from '@backend/infra/db/types';
import type { MonitorSpec } from '@mocco/common/status';

/** What happens after a monitor's state change commits. */
export type MonitorStateChangeHandler = (monitor: MonitorRow, change: MonitorStateChangeRow) => Promise<void>;

/** Run the handler for a committed change; a failure is logged and the change stands. */
export async function reactToStateChange(
  handler: MonitorStateChangeHandler | undefined,
  monitor: MonitorRow,
  change: MonitorStateChangeRow,
): Promise<void> {
  if (handler === undefined) {
    return;
  }
  try {
    await handler(monitor, change);
  } catch (error) {
    console.error('[status] reacting to a monitor state change failed; the change stands', {
      monitorId: monitor.id,
      stateChangeId: change.id,
      error,
    });
  }
}

interface Decision {
  outcome: RoundClose;
  change?: { monitor: MonitorRow; row: MonitorStateChangeRow };
}

export interface VerdictEvaluatorDeps {
  db: Db;
  /** Called once per committed change, in order; a failure is logged and never undoes the change. */
  onStateChange?: MonitorStateChangeHandler;
  now?: () => Date;
}

/** Rounds closed per run at most; the next minute picks up the rest, oldest first. */
const BATCH = 500;

export const RoundCloses = { open: 'open', closed: 'closed', changed: 'changed', skipped: 'skipped' } as const;
type RoundClose = (typeof RoundCloses)[keyof typeof RoundCloses];

/** Whether the monitor's current round is inside a deploy watch: it started before `watch_until`. */
export function isWatchedRound(monitor: Pick<MonitorRow, 'nextRoundAt' | 'watchUntil'>): boolean {
  return monitor.watchUntil !== null && monitor.nextRoundAt < monitor.watchUntil;
}

/** The next round: one interval after this one (the watch interval inside a deploy watch), or
 * now when that is already past or a recheck is due. */
function nextRoundOf(monitor: MonitorRow, now: Date, isRecheck: boolean): Date {
  const interval = isWatchedRound(monitor)
    ? (monitor.watchIntervalSeconds ?? monitor.intervalSeconds)
    : monitor.intervalSeconds;
  const scheduled = monitor.nextRoundAt.getTime() + interval * 1000;
  return isRecheck || scheduled <= now.getTime() ? now : new Date(scheduled);
}

export class VerdictEvaluator {
  constructor(private readonly deps: VerdictEvaluatorDeps) {}

  private async closeRound(candidate: MonitorRow, now: Date): Promise<RoundClose> {
    const result = isProbeSpec(candidate.spec)
      ? await this.decideRound(candidate, candidate.spec, now)
      : await this.decideSilence(candidate, now);
    if (result.change !== undefined) {
      await reactToStateChange(this.deps.onStateChange, result.change.monitor, result.change.row);
    }
    return result.outcome;
  }

  /** A heartbeat whose deadline passed without a ping: down (or still down), with a new deadline. */
  private async decideSilence(candidate: MonitorRow, now: Date): Promise<Decision> {
    const scope = { workspaceId: candidate.workspaceId, projectId: candidate.projectId };
    return await this.deps.db.transaction(async tx => {
      const monitor = await new MonitorRepo(tx).lockForStateChange(scope, candidate.id);
      // Paused, deleted, or pinged since it was read (a ping moves the deadline).
      if (
        monitor === undefined ||
        monitor.state === MonitorStates.paused ||
        monitor.nextRoundAt.getTime() !== candidate.nextRoundAt.getTime()
      ) {
        return { outcome: RoundCloses.skipped };
      }
      const applied = await applyHeartbeatVerdict(tx, monitor, RoundVerdicts.fail, {
        now,
        ping: {},
        reason: {
          by: 'evaluator',
          cause: HeartbeatCauses.silence,
          lastPingAt: monitor.lastPingAt?.toISOString() ?? null,
        },
      });
      return applied.change === undefined
        ? { outcome: RoundCloses.closed }
        : { outcome: RoundCloses.changed, change: { monitor: applied.monitor, row: applied.change } };
    });
  }

  private async decideRound(candidate: MonitorRow, spec: MonitorSpec, now: Date): Promise<Decision> {
    const scope = { workspaceId: candidate.workspaceId, projectId: candidate.projectId };
    const roundAt = candidate.nextRoundAt;
    const [reports, assigned] = await Promise.all([
      new CheckResultRepo(this.deps.db).listForRound(candidate.workspaceId, candidate.id, roundAt),
      new MonitorLocationRepo(this.deps.db).countEnabled(candidate.workspaceId, candidate.id),
    ]);
    const deadline = leaseExpiry({ roundAt, spec });
    if (reports.length < assigned && now <= deadline) {
      return { outcome: RoundCloses.open };
    }
    return await this.deps.db.transaction(async tx => {
      const monitors = new MonitorRepo(tx);
      const monitor = await monitors.lockForStateChange(scope, candidate.id);
      // Paused, deleted, or closed by another evaluator since it was read.
      if (
        monitor === undefined ||
        monitor.state === MonitorStates.paused ||
        monitor.nextRoundAt.getTime() !== roundAt.getTime()
      ) {
        return { outcome: RoundCloses.skipped };
      }
      const tally = tallyRound(
        reports.map(report => ({ outcome: report.outcome, latencyMs: report.latencyMs })),
        {
          assigned,
          quorumMode: monitor.quorumMode,
          latencyThresholdMs: monitor.spec.kind === MonitorKinds.http ? monitor.spec.latencyThresholdMs : undefined,
        },
      );
      await new RoundVerdictRepo(tx).insert({
        monitorId: monitor.id,
        roundAt,
        workspaceId: monitor.workspaceId,
        ...tally,
        closedAt: now,
      });
      const next = nextState(monitor, tally.verdict, monitor);
      const isMoved = next.state !== monitor.state;
      // The first round at or past `watch_until` ends the watch: the normal interval resumes.
      const isWatchOver = monitor.watchUntil !== null && !isWatchedRound(monitor);
      const updated = await monitors.setState(
        scope,
        monitor.id,
        {
          state: next.state,
          consecutiveFails: next.consecutiveFails,
          consecutiveOks: next.consecutiveOks,
          nextRoundAt: nextRoundOf(monitor, now, next.recheck),
          ...(isMoved && { stateChangedAt: now }),
          ...(isWatchOver && { watchUntil: null, watchIntervalSeconds: null, watchRunId: null }),
        },
        now,
      );
      if (!isMoved) {
        return { outcome: RoundCloses.closed };
      }
      const row = await new MonitorStateChangeRepo(tx).append({
        workspaceId: monitor.workspaceId,
        monitorId: monitor.id,
        fromState: monitor.state,
        toState: next.state,
        at: now,
        roundAt,
        reason: {
          by: 'evaluator',
          verdict: tally.verdict,
          okCount: tally.okCount,
          failCount: tally.failCount,
          noDataCount: tally.noDataCount,
        },
      });
      return { outcome: RoundCloses.changed, change: { monitor: updated, row } };
    });
  }

  /** Close every round that can be closed (only the given monitors' when `monitorIds` is set). */
  async evaluate(
    opts: { now?: Date; monitorIds?: readonly string[] } = {},
  ): Promise<{ closed: number; changed: number }> {
    const now = opts.now ?? this.deps.now?.() ?? new Date();
    const candidates = await new MonitorRepo(this.deps.db).listRoundsStarted(now, {
      ...(opts.monitorIds !== undefined && { monitorIds: opts.monitorIds }),
      limit: BATCH,
    });
    if (candidates.length === 0) {
      return { closed: 0, changed: 0 };
    }
    // Verdicts are written inside transactions, where a missing partition can't be retried.
    const verdicts = new RoundVerdictRepo(this.deps.db);
    const existing = new Set(await verdicts.partitions.days());
    await verdicts.partitions.ensure(
      [...new Set(candidates.map(monitor => utcDayOf(monitor.nextRoundAt)))].filter(day => !existing.has(day)),
    );
    const outcomes = await candidates.reduce<Promise<RoundClose[]>>(async (previous, monitor) => {
      const done = await previous;
      return [...done, await this.closeRound(monitor, now)];
    }, Promise.resolve([]));
    return {
      closed: outcomes.filter(outcome => outcome === RoundCloses.closed || outcome === RoundCloses.changed).length,
      changed: outcomes.filter(outcome => outcome === RoundCloses.changed).length,
    };
  }
}
