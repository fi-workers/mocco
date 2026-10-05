// The IndexNow HTTP sender (#367): the shared endpoint forwards a submission to every
// participating engine. 200 and 202 are accepted; anything else throws so the job retries.
import { HelpIndexNow } from '@backend/domain/helpcenter/indexnow';
import { helpSiteOrigin } from '@backend/domain/helpcenter/site-url';

import type { IndexNowSender } from '@backend/domain/helpcenter/indexnow';
import type { Env } from '@backend/infra/config/env';
import type { Db } from '@backend/infra/db/types';

export class HttpIndexNowSender implements IndexNowSender {
  constructor(private readonly options: { endpoint?: string; fetch?: typeof fetch; timeoutMs?: number } = {}) {}

  async submit(submission: { host: string; key: string; keyLocation: string; urls: readonly string[] }) {
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(this.options.endpoint ?? 'https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: submission.host,
        key: submission.key,
        keyLocation: submission.keyLocation,
        urlList: submission.urls,
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    if (response.status !== 200 && response.status !== 202) {
      throw new Error(`IndexNow answered ${response.status}`);
    }
  }
}

/**
 * IndexNow for production only: a preview or local deployment submitting its pages would
 * advertise hosts that aren't the site's. Needs AUTH_SECRET (the key) and HELP_SITES_DOMAIN.
 */
// eslint-disable-next-line sonarjs/function-return-type -- undefined means "off", as translatorFromEnv
export function helpIndexNowFromEnv(db: Db, env: Env): HelpIndexNow | undefined {
  const secret = env.AUTH_SECRET;
  if (env.VERCEL_ENV !== 'production' || secret === undefined || env.HELP_SITES_DOMAIN === undefined) {
    return undefined;
  }
  return new HelpIndexNow({
    db,
    secret,
    originOf: slug => helpSiteOrigin(slug, env),
    sender: new HttpIndexNowSender(),
  });
}
