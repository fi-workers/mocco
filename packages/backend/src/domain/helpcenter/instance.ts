// Production composition root for the help center. Lazy so builds don't need env at import.
import { createHash } from 'node:crypto';

import { getAudit } from '@backend/domain/audit/instance';
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { HELP_FEEDBACK_RATE_LIMIT, helpFeedbackSecret } from '@backend/domain/helpcenter/HelpFeedbackService';
import { indexNowKey } from '@backend/domain/helpcenter/indexnow';
import { helpIndexNowFromEnv } from '@backend/domain/helpcenter/indexnow-http';
import { HttpHelpRevalidator } from '@backend/domain/helpcenter/revalidate-http';
import { helpSiteOrigin } from '@backend/domain/helpcenter/site-url';
import { translatorFromEnv } from '@backend/domain/helpcenter/translate/ai-gateway';
import { getJobQueue } from '@backend/domain/jobs/instance';
import { getRateLimiter } from '@backend/domain/ratelimit/instance';
import { getStorageDomain } from '@backend/domain/storage/instance';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';

const state: { help?: HelpDomain } = {};

export function getHelpDomain(): HelpDomain {
  const storage = getStorageDomain()?.storage;
  const env = getEnv();
  const translator = translatorFromEnv(env);
  // The job tick's secret also guards /api/help/revalidate: both are this deployment calling itself.
  const secret = env.CRON_SECRET ?? env.JOBS_TICK_SECRET;
  const revalidator =
    secret === undefined
      ? undefined
      : new HttpHelpRevalidator({
          origin: resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL }),
          secret,
        });
  state.help ??= createHelpDomain(getDb(), {
    audit: getAudit().audit,
    queue: getJobQueue(),
    indexNow: helpIndexNowFromEnv(getDb(), env) !== undefined,
    feedbackSecret: () => helpFeedbackSecret(getEnv().AUTH_SECRET),
    ...(env.HELP_TRANSLATION_MONTHLY_CHARACTERS !== undefined && {
      translationMonthlyCharacters: env.HELP_TRANSLATION_MONTHLY_CHARACTERS,
    }),
    ...(storage !== undefined && { storage }),
    ...(translator !== undefined && { translator }),
    ...(revalidator !== undefined && { revalidator }),
  });
  return state.help;
}

/** The secrets `/api/help/revalidate` accepts: the job tick's (none set → it answers 503). */
export function helpRevalidateSecrets(): string[] {
  const env = getEnv();
  return [env.CRON_SECRET, env.JOBS_TICK_SECRET].filter(secret => secret !== undefined);
}

/** A help site's IndexNow key (#367), or null without AUTH_SECRET. */
export function helpIndexNowKeyFor(slug: string): string | null {
  const secret = getEnv().AUTH_SECRET;
  return secret === undefined ? null : indexNowKey(secret, slug);
}

/** Where a help site is served (its custom domain, else its Mocco subdomain), or null. */
export function helpSiteOriginFor(slug: string): string | null {
  return helpSiteOrigin(slug, getEnv());
}

/** Whether the public site may take another "Was this helpful?" answer from `address` now. */
export async function allowHelpFeedbackFrom(address: string): Promise<boolean> {
  const bucket = `help-feedback:${createHash('sha256').update(address).digest('hex').slice(0, 16)}`;
  const result = await getRateLimiter().consume(bucket, HELP_FEEDBACK_RATE_LIMIT);
  return result.allowed;
}

export { checkRevalidateRequest } from '@backend/domain/helpcenter/revalidate';
