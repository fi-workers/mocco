// What status subscribers need from the env: the key their links are signed with (derived from
// AUTH_SECRET) and the email sender (EMAIL_DRIVER). Pure over the env, so the request-side and
// job-side composition roots share it.
import { createHash } from 'node:crypto';

import { createEmailSenderFromEnv } from '@backend/domain/notification/email-config';
import { SubscriberTokens } from '@backend/domain/status/subscriber-token';

import type { EmailSender } from '@backend/domain/notification/senders/email';
import type { Env } from '@backend/infra/config/env';

export interface SubscriberEnvDeps {
  tokens: SubscriberTokens;
  email: EmailSender | undefined;
}

/** Undefined without AUTH_SECRET: links can't be signed, so there are no subscriptions. */
// eslint-disable-next-line sonarjs/function-return-type -- undefined is the "not configured" answer
export function subscriberDepsFromEnv(
  env: Pick<Env, 'AUTH_SECRET' | 'EMAIL_DRIVER' | 'EMAIL_FROM' | 'EMAIL_SMTP_URL'>,
): SubscriberEnvDeps | undefined {
  if (env.AUTH_SECRET === undefined) {
    return undefined;
  }
  const key = createHash('sha256').update(`mocco-status-subscribers:${env.AUTH_SECRET}`).digest('hex');
  return { tokens: new SubscriberTokens(key), email: createEmailSenderFromEnv(env) };
}
