// Production composition root for the feedback domain. Lazy so builds don't need env at import.
import { getAudit } from '@backend/domain/audit/instance';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { getDb } from '@backend/infra/db/client';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';

const state: { feedback?: FeedbackDomain } = {};

export function getFeedbackDomain(): FeedbackDomain {
  state.feedback ??= createFeedbackDomain(getDb(), { audit: getAudit().audit });
  return state.feedback;
}
