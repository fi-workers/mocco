// The deploy watch (#155): right after a release, the released projects' monitors check every
// 30 seconds for 15 minutes, so a deploy that breaks a check is seen within a minute and the
// incident it opens points at the run (MonitorTransitionService). It starts on `deploy.released`
// (status/subscribers.ts), so only a production release starts one: a run that succeeded and
// passed a resumed gate (docs/reference/releases.md), never any CI run that succeeded.
//
// Starting a watch only sets the monitor's watch columns and pulls a round that isn't due yet
// to now. The evaluator reads them: it schedules watched rounds at the watch interval and clears
// the watch at the first round past `watch_until`, so the normal interval resumes with no job.
import { DeployWatch, MonitorStates } from '@mocco/common/status';

import { MonitorRepo } from '@backend/domain/status/repos/monitor.repo';

import type { Db } from '@backend/infra/db/types';

export interface DeployWatchDeps {
  db: Db;
  now?: () => Date;
}

export interface ReleaseToWatch {
  workspaceId: string;
  /** The projects the release was recorded for: their monitors are watched. */
  projectIds: readonly string[];
  runId: string;
  releasedAt: Date;
}

/** When a release's watch ends: 15 minutes after the run finished. */
export const watchUntilOf = (releasedAt: Date): Date => new Date(releasedAt.getTime() + DeployWatch.durationMs);

export class DeployWatchService {
  constructor(private readonly deps: DeployWatchDeps) {}

  /**
   * Watch the monitors of the release's projects (paused ones excepted) until 15 minutes after
   * it finished. The window counts from the release, not from delivery, so a redelivered event
   * keeps the same window and a release delivered more than 15 minutes late starts no watch. A monitor
   * already watching a later release keeps that watch. Returns the monitors now watching this run.
   */
  async startWatch(release: ReleaseToWatch): Promise<{ watched: number }> {
    const now = this.deps.now?.() ?? new Date();
    const watchUntil = watchUntilOf(release.releasedAt);
    if (watchUntil <= now) {
      return { watched: 0 };
    }
    const candidates = await new MonitorRepo(this.deps.db).listWatchable(release.workspaceId, release.projectIds);
    if (candidates.length === 0) {
      return { watched: 0 };
    }
    // One transaction, monitors locked in id order: the evaluator takes the same lock to close a
    // round, so a watch never lands between its read and its write.
    const watched = await this.deps.db.transaction(async tx => {
      const monitors = new MonitorRepo(tx);
      return await candidates.reduce<Promise<number>>(async (previous, candidate) => {
        const count = await previous;
        const scope = { workspaceId: candidate.workspaceId, projectId: candidate.projectId };
        const monitor = await monitors.lockForStateChange(scope, candidate.id);
        // Deleted or paused since it was listed: a paused monitor has no rounds to watch.
        if (monitor === undefined || monitor.state === MonitorStates.paused) {
          return count;
        }
        const started = await monitors.startWatch(scope, monitor.id, {
          watchUntil,
          intervalSeconds: DeployWatch.intervalSeconds,
          runId: release.runId,
          // A round already due (or open) stays as it is; a later one is pulled to now.
          nextRoundAt: new Date(Math.min(monitor.nextRoundAt.getTime(), now.getTime())),
          at: now,
        });
        return started === undefined ? count : count + 1;
      }, Promise.resolve(0));
    });
    return { watched };
  }
}
