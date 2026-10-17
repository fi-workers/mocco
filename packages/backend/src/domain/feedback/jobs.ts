// The feedback domain's job handlers, as pure factories. runtime/jobs.ts registers them; this
// module never imports an instance.ts.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { ChangelogService } from '@backend/domain/feedback/ChangelogService';
import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';

export const FeedbackJobKinds = {
  publishDueChangelog: 'feedback.changelog.publish_due',
} as const;

/** Publish the changelog entries whose scheduled time has come (#176). */
export const publishDueChangelog = defineJob(FeedbackJobKinds.publishDueChangelog, z.object({}));

export const feedbackSchedules: SystemSchedule[] = [
  { kind: FeedbackJobKinds.publishDueChangelog, payload: {}, intervalSeconds: 60 },
];

export function createFeedbackHandlers(deps: { changelog: Pick<ChangelogService, 'publishDue'> }): JobHandler[] {
  return [
    handleJob(publishDueChangelog, async () => {
      await deps.changelog.publishDue();
    }),
  ];
}
