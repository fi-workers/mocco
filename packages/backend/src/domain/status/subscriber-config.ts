// What status subscribers need from the env: the key their links are signed with (derived from
// AUTH_SECRET), the email sender (EMAIL_DRIVER), and for webhooks the SecretBox that seals their
// signing secrets (SECRETS_ENCRYPTION_KEYS) and the sender that calls them, which refuses every
// address that isn't public. Pure over the env, so the request-side and job-side composition
// roots share it.
import { createHash } from 'node:crypto';

import { isPublicAddress } from '@mocco/common/address-policy';

import { createEmailSenderFromEnv } from '@backend/domain/notification/email-config';
import { WebhookSender } from '@backend/domain/notification/senders/webhook';
import { SubscriberTokens } from '@backend/domain/status/subscriber-token';
import { createSecretBox } from '@backend/infra/crypto/instance';

import type { EmailSender } from '@backend/domain/notification/senders/email';
import type { Env } from '@backend/infra/config/env';
import type { SecretBox } from '@backend/infra/crypto/secret-box';

export interface SubscriberEnvDeps {
  tokens: SubscriberTokens;
  email: EmailSender | undefined;
  /** Undefined without SECRETS_ENCRYPTION_KEYS: no webhook sign-ups. */
  box?: Pick<SecretBox, 'seal' | 'open'>;
  webhooks?: Pick<WebhookSender, 'send' | 'refusalOf'>;
}

/** Undefined without AUTH_SECRET: links can't be signed, so there are no subscriptions. */
// eslint-disable-next-line sonarjs/function-return-type -- undefined is the "not configured" answer
export function subscriberDepsFromEnv(
  env: Pick<Env, 'AUTH_SECRET' | 'EMAIL_DRIVER' | 'EMAIL_FROM' | 'EMAIL_SMTP_URL' | 'SECRETS_ENCRYPTION_KEYS'>,
): SubscriberEnvDeps | undefined {
  if (env.AUTH_SECRET === undefined) {
    return undefined;
  }
  const key = createHash('sha256').update(`mocco-status-subscribers:${env.AUTH_SECRET}`).digest('hex');
  return {
    tokens: new SubscriberTokens(key),
    email: createEmailSenderFromEnv(env),
    ...(env.SECRETS_ENCRYPTION_KEYS !== undefined && {
      box: createSecretBox(env.SECRETS_ENCRYPTION_KEYS),
      webhooks: new WebhookSender({ policy: isPublicAddress }),
    }),
  };
}
