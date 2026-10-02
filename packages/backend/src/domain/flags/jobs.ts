// The flags domain's job handlers, as pure factories. runtime/jobs.ts registers them;
// this module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { FlagGovernanceService } from '@backend/domain/flags/FlagGovernanceService';
import type { StaleFlagDetector } from '@backend/domain/flags/StaleFlagDetector';
import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';

export const FlagJobKinds = {
  expireChangesets: 'flags.changesets.expire',
  detectStale: 'flags.stale.detect',
  staleDigest: 'flags.stale.digest',
} as const;

/** Expire changesets to protected environments that waited past their approval window. */
export const expireFlagChangesets = defineJob(FlagJobKinds.expireChangesets, z.object({}));

export const expireFlagChangesetsSchedule: SystemSchedule = {
  kind: FlagJobKinds.expireChangesets,
  payload: {},
  intervalSeconds: 15 * 60,
};

/** Rewrite the stale-flag findings from telemetry and configs, and prune old rollups. */
export const detectStaleFlags = defineJob(FlagJobKinds.detectStale, z.object({}));

export const detectStaleFlagsSchedule: SystemSchedule = {
  kind: FlagJobKinds.detectStale,
  payload: {},
  intervalSeconds: 24 * 60 * 60,
};

/** Tell each project which flags look ready for cleanup. */
export const sendStaleFlagDigests = defineJob(FlagJobKinds.staleDigest, z.object({}));

export const sendStaleFlagDigestsSchedule: SystemSchedule = {
  kind: FlagJobKinds.staleDigest,
  payload: {},
  intervalSeconds: 7 * 24 * 60 * 60,
};

export const flagSchedules: SystemSchedule[] = [
  expireFlagChangesetsSchedule,
  detectStaleFlagsSchedule,
  sendStaleFlagDigestsSchedule,
];

export function createFlagHandlers(deps: {
  governance: FlagGovernanceService;
  stale: StaleFlagDetector;
}): JobHandler[] {
  return [
    handleJob(expireFlagChangesets, async () => {
      await deps.governance.expireDue();
    }),
    handleJob(detectStaleFlags, async () => {
      await deps.stale.detectAll();
      await deps.stale.pruneRollups();
    }),
    handleJob(sendStaleFlagDigests, async () => {
      await deps.stale.sendDigests();
    }),
  ];
}
