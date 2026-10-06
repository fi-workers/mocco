// What feedback's mail links need from the env (#174): the key they are signed with (derived from
// AUTH_SECRET, apart from the status subscribers' key) and the email sender (EMAIL_DRIVER). Pure
// over the env, so the composition root and tests share it.
import { createHash } from 'node:crypto';

import { FeedbackLinkTokens } from '@backend/domain/feedback/link-tokens';
import { createEmailSenderFromEnv } from '@backend/domain/notification/email-config';

import type { EmailSender } from '@backend/domain/notification/senders/email';
import type { Env } from '@backend/infra/config/env';

export interface FeedbackLinkEnvDeps {
  tokens: FeedbackLinkTokens;
  email: EmailSender | undefined;
}

/** Undefined without AUTH_SECRET: links can't be signed, so there is no voting by email. */
// eslint-disable-next-line sonarjs/function-return-type -- undefined is the "not configured" answer
export function feedbackLinkDepsFromEnv(
  env: Pick<Env, 'AUTH_SECRET' | 'EMAIL_DRIVER' | 'EMAIL_FROM' | 'EMAIL_SMTP_URL'>,
): FeedbackLinkEnvDeps | undefined {
  if (env.AUTH_SECRET === undefined) {
    return undefined;
  }
  const key = createHash('sha256').update(`mocco-feedback-links:${env.AUTH_SECRET}`).digest('hex');
  return { tokens: new FeedbackLinkTokens(key), email: createEmailSenderFromEnv(env) };
}
