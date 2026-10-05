// The heartbeat pings (#153): `/v1/ping/:token[/start|/fail|/:exitCode]`. The token is the only
// credential: it is looked up by its SHA-256 hash, and a token that matches no heartbeat is
// reported as not found, which the route answers exactly like a missing route.
//
// A completion ping (success, fail, or an exit code) records `last_ping_at` and, after a
// `/start`, the run's duration, then moves the state (heartbeat.ts) and restarts the silence
// deadline. `/start` only records the start: a job that started and never finished goes down
// when the deadline passes, like one that never ran. A paused monitor records its pings but its
// state doesn't move; resuming starts a fresh deadline from the resume.
import { MonitorStates, RoundVerdicts } from '@mocco/common/status';

import { applyHeartbeatVerdict, HeartbeatCauses, HeartbeatSignals } from '@backend/domain/status/heartbeat';
import { hashHeartbeatToken } from '@backend/domain/status/heartbeat-token';
import { MonitorRepo } from '@backend/domain/status/repos/monitor.repo';
import { reactToStateChange } from '@backend/domain/status/VerdictEvaluator';

import type { HeartbeatSignal } from '@backend/domain/status/heartbeat';
import type { MonitorStateChangeRow } from '@backend/domain/status/repos/monitor-state-change.repo';
import type { MonitorRow } from '@backend/domain/status/repos/monitor.repo';
import type { MonitorStateChangeHandler } from '@backend/domain/status/VerdictEvaluator';
import type { Db } from '@backend/infra/db/types';

export interface HeartbeatDeps {
  db: Db;
  /** The same reaction the evaluator's changes get: pages, incidents and alerts. */
  onStateChange?: MonitorStateChangeHandler;
  now?: () => Date;
}

export interface HeartbeatPing {
  signal: HeartbeatSignal;
  /** The job's exit code, from `/:exitCode`: 0 is a success, anything else a failure. */
  exitCode?: number;
}

/** The longest duration stored (an int column): about 24 days. */
const MAX_DURATION_MS = 2_147_483_647;

/** The run's duration: from the last `/start` to this completion, when it started after the
 * previous completion. A completion without a start has none. */
function durationOf(monitor: MonitorRow, now: Date): number | null {
  const started = monitor.lastStartAt;
  if (started === null || (monitor.lastPingAt !== null && started <= monitor.lastPingAt)) {
    return null;
  }
  return Math.min(MAX_DURATION_MS, Math.max(0, now.getTime() - started.getTime()));
}

export class HeartbeatService {
  constructor(private readonly deps: HeartbeatDeps) {}

  /** Record a ping. False when the token matches no heartbeat monitor (nothing is written). */
  async ping(token: string, ping: HeartbeatPing): Promise<boolean> {
    const tokenHash = hashHeartbeatToken(token);
    const found = await new MonitorRepo(this.deps.db).findByHeartbeatTokenHash(tokenHash);
    if (found === undefined) {
      return false;
    }
    const now = this.deps.now?.() ?? new Date();
    const scope = { workspaceId: found.workspaceId, projectId: found.projectId };
    const result = await this.deps.db.transaction(
      async (tx): Promise<{ isFound: boolean; change?: { monitor: MonitorRow; row: MonitorStateChangeRow } }> => {
        const monitors = new MonitorRepo(tx);
        const monitor = await monitors.lockForStateChange(scope, found.id);
        // Deleted, or its token rotated, since the lookup.
        if (monitor?.heartbeatTokenHash !== tokenHash) {
          return { isFound: false };
        }
        if (ping.signal === HeartbeatSignals.start) {
          await monitors.setState(scope, monitor.id, { state: monitor.state, lastStartAt: now }, now);
          return { isFound: true };
        }
        const values = { lastPingAt: now, lastDurationMs: durationOf(monitor, now) };
        if (monitor.state === MonitorStates.paused) {
          await monitors.setState(scope, monitor.id, { state: monitor.state, ...values }, now);
          return { isFound: true };
        }
        const isFailure = ping.signal === HeartbeatSignals.fail || (ping.exitCode ?? 0) !== 0;
        const applied = await applyHeartbeatVerdict(tx, monitor, isFailure ? RoundVerdicts.fail : RoundVerdicts.ok, {
          now,
          ping: values,
          reason: {
            by: 'heartbeat',
            cause: isFailure ? HeartbeatCauses.fail : HeartbeatCauses.success,
            ...(ping.exitCode !== undefined && { exitCode: ping.exitCode }),
          },
        });
        return {
          isFound: true,
          ...(applied.change !== undefined && { change: { monitor: applied.monitor, row: applied.change } }),
        };
      },
    );
    if (result.change !== undefined) {
      await reactToStateChange(this.deps.onStateChange, result.change.monitor, result.change.row);
    }
    return result.isFound;
  }
}
