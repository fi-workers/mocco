// The email sender this deployment is configured with (EMAIL_DRIVER), or undefined when it has
// none. Pure over the env, so the composition roots and tests share it.
import { LogEmailSender } from '@backend/domain/notification/senders/email';
import { SmtpEmailSender } from '@backend/domain/notification/senders/smtp';

import type { EmailSender } from '@backend/domain/notification/senders/email';
import type { Env } from '@backend/infra/config/env';

/** sonarjs/function-return-type is a false positive: undefined is the "not configured" answer. */
// eslint-disable-next-line sonarjs/function-return-type
export function createEmailSenderFromEnv(
  env: Pick<Env, 'EMAIL_DRIVER' | 'EMAIL_FROM' | 'EMAIL_SMTP_URL'>,
): EmailSender | undefined {
  switch (env.EMAIL_DRIVER) {
    case 'log': {
      return new LogEmailSender();
    }
    case 'smtp': {
      if (env.EMAIL_SMTP_URL === undefined || env.EMAIL_FROM === undefined) {
        throw new Error('EMAIL_DRIVER=smtp needs EMAIL_SMTP_URL and EMAIL_FROM');
      }
      return SmtpEmailSender.fromUrl(env.EMAIL_SMTP_URL, env.EMAIL_FROM);
    }
    case undefined: {
      return undefined;
    }
    default: {
      const unknown: never = env.EMAIL_DRIVER;
      throw new Error(`unknown EMAIL_DRIVER ${String(unknown)}`);
    }
  }
}
