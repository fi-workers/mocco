// Evaluation telemetry (#144): SDKs report how often each flag served each variant over
// a window; this adds the counts to hourly rollups. Advisory only: stale detection reads
// the rollups, no governance decision does, so a spoofed report can at worst hide or
// raise a cleanup hint. Unknown flags (and, for publishable keys, flags that aren't
// available to browsers and apps) are ignored, so a report can't grow the table with
// made-up keys.
import { ApiKeyKinds } from '@mocco/common/apikey';
import { FlagTelemetryLimits } from '@mocco/common/flags';

import { FlagEnvironmentNotFoundError } from '@backend/domain/flags/errors';
import { FlagEnvironmentRepo } from '@backend/domain/flags/repos/flag-environment.repo';
import { FlagEvalRollupRepo } from '@backend/domain/flags/repos/flag-eval-rollup.repo';
import { FlagRepo } from '@backend/domain/flags/repos/flag.repo';

import type { RollupRow } from '@backend/domain/flags/repos/flag-eval-rollup.repo';
import type { Db } from '@backend/infra/db/types';
import type { ApiKeyKind } from '@mocco/common/apikey';
import type { FlagTelemetryInput } from '@mocco/common/flags';

const HOUR_MS = 60 * 60 * 1000;

export interface TelemetryReporter {
  workspaceId: string;
  environmentId: string;
  keyKind: ApiKeyKind;
}

export class FlagTelemetryService {
  constructor(private readonly deps: { db: Db }) {}

  /** Add a report's counts to their hourly buckets. Entries for unknown or hidden flags,
   * or with a window outside the accepted range, are counted as ignored. */
  async ingest(
    reporter: TelemetryReporter,
    input: FlagTelemetryInput,
    now = new Date(),
  ): Promise<{ accepted: number; ignored: number }> {
    const environment = await new FlagEnvironmentRepo(this.deps.db).byId(reporter.workspaceId, reporter.environmentId);
    if (environment === undefined) {
      throw new FlagEnvironmentNotFoundError(reporter.environmentId);
    }
    const flags = await new FlagRepo(this.deps.db).listByProject(reporter.workspaceId, environment.projectId);
    const isPublishable = reporter.keyKind === ApiKeyKinds.publishable;
    const reportable = new Set(flags.filter(flag => !isPublishable || flag.clientVisible).map(flag => flag.key));
    const earliest = now.getTime() - FlagTelemetryLimits.maxWindowAgeMs;
    const latest = now.getTime() + FlagTelemetryLimits.maxClockSkewMs;

    const accepted = input.evaluations.filter(entry => {
      const start = Date.parse(entry.windowStart);
      return reportable.has(entry.flag) && start >= earliest && start <= latest;
    });
    // One row per (flag, variant, hour): the upsert can't touch a row twice.
    const buckets = accepted.reduce<Record<string, RollupRow>>((rows, entry) => {
      const bucketHour = new Date(Math.floor(Date.parse(entry.windowStart) / HOUR_MS) * HOUR_MS);
      const variant = entry.variant ?? '';
      const id = `${entry.flag}\n${variant}\n${bucketHour.getTime()}`;
      return {
        ...rows,
        [id]: {
          environmentId: environment.id,
          workspaceId: reporter.workspaceId,
          flagKey: entry.flag,
          variant,
          bucketHour,
          count: (rows[id]?.count ?? 0) + entry.count,
          lastSeenAt: now,
        },
      };
    }, {});
    await new FlagEvalRollupRepo(this.deps.db).addCounts(Object.values(buckets));
    return { accepted: accepted.length, ignored: input.evaluations.length - accepted.length };
  }

  /** A project's evaluations over the last `days`, per flag: the total and when last seen. */
  async usage(workspaceId: string, projectId: string, days: number, now = new Date()) {
    const rows = await new FlagEvalRollupRepo(this.deps.db).usage(
      workspaceId,
      projectId,
      new Date(now.getTime() - days * 24 * HOUR_MS),
    );
    const latest = (a: Date | null, b: Date | null) => (a === null || (b !== null && b > a) ? b : a);
    const byFlag = rows.reduce<Record<string, { flagKey: string; evaluations: number; lastSeenAt: Date | null }>>(
      (flags, row) => {
        const previous = flags[row.flagKey];
        return {
          ...flags,
          [row.flagKey]: {
            flagKey: row.flagKey,
            evaluations: (previous?.evaluations ?? 0) + row.evaluations,
            lastSeenAt: latest(previous?.lastSeenAt ?? null, row.lastSeenAt),
          },
        };
      },
      {},
    );
    return Object.values(byFlag);
  }
}
