// The feedback domain's job handlers, as pure factories. runtime/jobs.ts registers them; this
// module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { ChangelogService } from '@backend/domain/feedback/ChangelogService';
import type { DuplicateService } from '@backend/domain/feedback/DuplicateService';
import type { StatusMailService } from '@backend/domain/feedback/StatusMailService';
import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';

export const FeedbackJobKinds = {
  publishDueChangelog: 'feedback.changelog.publish_due',
  statusMail: 'feedback.status.mail',
  detectDuplicates: 'feedback.duplicates.detect',
} as const;

/** Publish the changelog entries whose scheduled time has come (#176). */
export const publishDueChangelog = defineJob(FeedbackJobKinds.publishDueChangelog, z.object({}));

/** Mail followers about status changes past their undo window, and send what is queued (#180). */
export const sendStatusMail = defineJob(FeedbackJobKinds.statusMail, z.object({}));

/** Compare new posts with their boards' older posts and suggest duplicate pairs (#181). */
export const detectDuplicates = defineJob(FeedbackJobKinds.detectDuplicates, z.object({}));

export const feedbackSchedules: SystemSchedule[] = [
  { kind: FeedbackJobKinds.publishDueChangelog, payload: {}, intervalSeconds: 60 },
  { kind: FeedbackJobKinds.statusMail, payload: {}, intervalSeconds: 60 },
  { kind: FeedbackJobKinds.detectDuplicates, payload: {}, intervalSeconds: 60 },
];

export function createFeedbackHandlers(deps: {
  changelog: Pick<ChangelogService, 'publishDue'>;
  statusMail: Pick<StatusMailService, 'fanOutDue' | 'sendQueued'>;
  duplicates: Pick<DuplicateService, 'detectDue'>;
}): JobHandler[] {
  return [
    handleJob(publishDueChangelog, async () => {
      await deps.changelog.publishDue();
    }),
    handleJob(sendStatusMail, async () => {
      await deps.statusMail.fanOutDue();
      await deps.statusMail.sendQueued();
    }),
    handleJob(detectDuplicates, async () => {
      await deps.duplicates.detectDue();
    }),
  ];
}
