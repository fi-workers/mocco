// The OTA domain's job handlers, as pure factories. runtime/jobs.ts registers them;
// this module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { UploadService } from '@backend/domain/ota/UploadService';

export const OtaJobKinds = {
  verifyAssets: 'ota.verifyAssets',
  pruneUploadSessions: 'ota.uploadSessions.prune',
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

export function createOtaHandlers(deps: { uploads: UploadService }): JobHandler[] {
  return [
    handleJob(verifyOtaAssets, async ({ releaseId }) => {
      await deps.uploads.verifyAssets(releaseId);
    }),
    handleJob(pruneUploadSessions, async () => {
      await deps.uploads.pruneSessions();
    }),
  ];
}
