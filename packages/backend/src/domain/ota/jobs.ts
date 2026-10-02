// The OTA domain's job handlers, as pure factories. runtime/jobs.ts registers them;
// this module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { OtaMetricsService } from '@backend/domain/ota/OtaMetricsService';
import type { UploadService } from '@backend/domain/ota/UploadService';

export const OtaJobKinds = {
  verifyAssets: 'ota.verifyAssets',
  pruneUploadSessions: 'ota.uploadSessions.prune',
  rollupMetrics: 'ota.rollupMetrics',
  pruneMetrics: 'ota.metrics.prune',
} as const;

/** Re-hash a finalized release's new assets and mark it ready (or failed). */
export const verifyOtaAssets = defineJob(OtaJobKinds.verifyAssets, z.object({ releaseId: z.uuid() }));

/** Drop expired upload sessions and fail the releases they abandoned. */
export const pruneUploadSessions = defineJob(OtaJobKinds.pruneUploadSessions, z.object({}));

export const pruneUploadSessionsSchedule: SystemSchedule = {
  kind: OtaJobKinds.pruneUploadSessions,
  payload: {},
  intervalSeconds: 24 * 60 * 60,
};

/** Roll device checks and client events into daily adoption, and alert on crash-fallback spikes. */
export const rollupOtaMetrics = defineJob(OtaJobKinds.rollupMetrics, z.object({}));

/** Retention for client events and silent devices (90 days). */
export const pruneOtaMetrics = defineJob(OtaJobKinds.pruneMetrics, z.object({}));

export const otaMetricsSchedules: SystemSchedule[] = [
  { kind: OtaJobKinds.rollupMetrics, payload: {}, intervalSeconds: 60 * 60 },
  { kind: OtaJobKinds.pruneMetrics, payload: {}, intervalSeconds: 24 * 60 * 60 },
];

export function createOtaHandlers(deps: { uploads: UploadService; metrics: OtaMetricsService }): JobHandler[] {
  return [
    handleJob(rollupOtaMetrics, async () => {
      await deps.metrics.rollup();
    }),
    handleJob(pruneOtaMetrics, async () => {
      await deps.metrics.prune();
    }),
    handleJob(verifyOtaAssets, async ({ releaseId }) => {
      await deps.uploads.verifyAssets(releaseId);
    }),
    handleJob(pruneUploadSessions, async () => {
      await deps.uploads.pruneSessions();
    }),
  ];
}
