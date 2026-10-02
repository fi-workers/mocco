// The storage domain's job handlers, as pure factories. runtime/jobs.ts registers them;
// this module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { StorageService } from '@backend/domain/storage/StorageService';

export const StorageJobKinds = {
  gc: 'storage.gc',
} as const;

/** Deletes abandoned pending uploads and drops rows of objects deleted long ago. */
export const collectStorageGarbage = defineJob(StorageJobKinds.gc, z.object({}));

/** Daily, as a platform schedule ensured by every tick. */
export const storageGcSchedule: SystemSchedule = {
  kind: StorageJobKinds.gc,
  payload: {},
  intervalSeconds: 24 * 60 * 60,
};

/** Without a configured store there is nothing to collect, so no handler is registered
 * (the schedule is only added alongside it). */
export function createStorageHandlers(deps: { storage: StorageService | undefined }): JobHandler[] {
  const { storage } = deps;
  if (storage === undefined) {
    return [];
  }
  return [
    handleJob(collectStorageGarbage, async () => {
      await storage.collectGarbage();
    }),
  ];
}
