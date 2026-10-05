// Heartbeat monitors (#153): a customer's job pings Mocco, and silence or a failure ping takes the
// monitor down. A heartbeat has no probes, rounds or verdict rows; its `next_round_at` is the
// silence deadline (the last ping, or the creation or resume, plus the period and the grace),
// which the verdict evaluator's per-minute scan picks up like a due round.
//
// Pings and silence go through the same state machine as probe rounds (`nextState`), with one
// confirmation each way: a ping is the job's own report, not a sample a flaky network can spoil,
// and silence already waited out the grace. So the first failure or silence is `down` and the
// next success is `up`, with the same state change rows (the source of downtime for rollups),
// incidents, page updates and alerts as any monitor.
import { z } from 'zod';

import { nextState } from '@backend/domain/status/consensus';
import { MonitorStateChangeRepo } from '@backend/domain/status/repos/monitor-state-change.repo';
import { MonitorRepo } from '@backend/domain/status/repos/monitor.repo';

import type { MonitorStateChangeRow } from '@backend/domain/status/repos/monitor-state-change.repo';
import type { HeartbeatPingValues, MonitorRow } from '@backend/domain/status/repos/monitor.repo';
import type { Db } from '@backend/infra/db/types';
import type { RoundVerdicts } from '@mocco/common/status';

/** What a ping says: the job finished (`success`), started (`start`), or failed (`fail`, or a
 * non-zero exit code). */
export const HeartbeatSignals = { success: 'success', start: 'start', fail: 'fail' } as const;
export type HeartbeatSignal = (typeof HeartbeatSignals)[keyof typeof HeartbeatSignals];

/** Why a heartbeat's state moved, in its state change `reason`. */
export const HeartbeatCauses = { ...HeartbeatSignals, silence: 'silence' } as const;

type HeartbeatTiming = Partial<Pick<MonitorRow, 'heartbeatPeriodSeconds' | 'heartbeatGraceSeconds'>>;

/** How long a heartbeat may stay silent: its period plus its grace. */
export const silenceWindowMs = (monitor: HeartbeatTiming): number =>
  ((monitor.heartbeatPeriodSeconds ?? 0) + (monitor.heartbeatGraceSeconds ?? 0)) * 1000;

/** When the heartbeat goes down if no ping arrives: `from` plus its period and grace. */
export const silenceDeadline = (monitor: HeartbeatTiming, from: Date): Date =>
  new Date(from.getTime() + silenceWindowMs(monitor));

/**
 * Move a heartbeat (locked with `lockForStateChange` in `tx`) by one ping or one silence: `ok` or
 * `fail` through `nextState`, the next silence deadline from `now`, the ping's own columns, and a
 * state change row when the state moved.
 */
export async function applyHeartbeatVerdict(
  tx: Db,
  monitor: MonitorRow,
  verdict: typeof RoundVerdicts.ok | typeof RoundVerdicts.fail,
  opts: { now: Date; ping: HeartbeatPingValues; reason: Record<string, unknown> },
): Promise<{ monitor: MonitorRow; change?: MonitorStateChangeRow }> {
  const scope = { workspaceId: monitor.workspaceId, projectId: monitor.projectId };
  const next = nextState(monitor, verdict, monitor);
  const isMoved = next.state !== monitor.state;
  const updated = await new MonitorRepo(tx).setState(
    scope,
    monitor.id,
    {
      ...opts.ping,
      state: next.state,
      consecutiveFails: next.consecutiveFails,
      consecutiveOks: next.consecutiveOks,
      nextRoundAt: silenceDeadline(monitor, opts.now),
      ...(isMoved && { stateChangedAt: opts.now }),
    },
    opts.now,
  );
  if (!isMoved) {
    return { monitor: updated };
  }
  const change = await new MonitorStateChangeRepo(tx).append({
    workspaceId: monitor.workspaceId,
    monitorId: monitor.id,
    fromState: monitor.state,
    toState: next.state,
    at: opts.now,
    reason: { verdict, ...opts.reason },
  });
  return { monitor: updated, change };
}

const heartbeatReasonSchema = z.object({
  cause: z.enum([HeartbeatCauses.success, HeartbeatCauses.fail, HeartbeatCauses.silence]),
  exitCode: z.int().optional(),
});

/** An alert's description of a heartbeat's change, or undefined for another monitor's. */
export function heartbeatAlertDescription(monitor: HeartbeatTiming, reason: unknown): string | undefined {
  const parsed = heartbeatReasonSchema.safeParse(reason);
  if (!parsed.success) {
    return undefined;
  }
  const { cause, exitCode } = parsed.data;
  if (cause === HeartbeatCauses.silence) {
    const minutes = Math.round(silenceWindowMs(monitor) / 60_000);
    return `No ping for ${minutes} min (the period and the grace).`;
  }
  if (cause === HeartbeatCauses.fail) {
    return exitCode === undefined ? 'The job reported a failure.' : `The job exited with code ${exitCode}.`;
  }
  return undefined;
}
