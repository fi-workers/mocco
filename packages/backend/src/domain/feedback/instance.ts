// Production composition root for the feedback domain. Lazy so builds don't need env at import.
import { getAudit } from '@backend/domain/audit/instance';
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { feedbackLinkDepsFromEnv } from '@backend/domain/feedback/link-config';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';

const state: { feedback?: FeedbackDomain } = {};

export function getFeedbackDomain(): FeedbackDomain {
  if (state.feedback === undefined) {
    const env = getEnv();
    const links = feedbackLinkDepsFromEnv(env);
    state.feedback = createFeedbackDomain(getDb(), {
      audit: getAudit().audit,
      ...(links !== undefined && {
        links: {
          ...links,
          appOrigin: resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL }),
        },
      }),
    });
  }
  return state.feedback;
}
