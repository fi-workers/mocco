// Production composition root for the help center. Lazy so builds don't need env at import.
import { getAudit } from '@backend/domain/audit/instance';
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { HttpHelpRevalidator } from '@backend/domain/helpcenter/revalidate-http';
import { helpSiteOrigin } from '@backend/domain/helpcenter/site-url';
import { translatorFromEnv } from '@backend/domain/helpcenter/translate/ai-gateway';
import { getJobQueue } from '@backend/domain/jobs/instance';
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

/** Where a help site is served (its custom domain, else its Mocco subdomain), or null. */
export function helpSiteOriginFor(slug: string): string | null {
  return helpSiteOrigin(slug, getEnv());
}

export { checkRevalidateRequest } from '@backend/domain/helpcenter/revalidate';
