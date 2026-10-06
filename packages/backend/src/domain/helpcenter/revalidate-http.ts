// The HTTP revalidator (#96): the backend asking this deployment's Next pages to rebuild.
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';

import type { HelpPageRevalidator } from '@backend/domain/helpcenter/revalidate';
import type { getEnv } from '@backend/infra/config/env';

/**
 * Asks this deployment's `/api/help/revalidate` to rebuild the pages, with the job tick's
 * secret as a bearer token. Answers in a few seconds or gives up.
 */
export class HttpHelpRevalidator implements HelpPageRevalidator {
  constructor(private readonly options: { origin: string; secret: string; fetch?: typeof fetch; timeoutMs?: number }) {}

  async revalidate(paths: readonly string[]): Promise<void> {
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(`${this.options.origin}/api/help/revalidate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ paths }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
    });
    if (!response.ok) {
      throw new Error(`/api/help/revalidate answered ${response.status}`);
    }
  }
}

/**
 * The deployment's revalidator: its own origin with the job tick's secret (which also guards
 * `/api/help/revalidate`, since both are this deployment calling itself). Undefined without
 * a secret: the pages then refresh on their own within the minute.
 */
export function helpRevalidatorFromEnv(env: ReturnType<typeof getEnv>): HttpHelpRevalidator | undefined {
  const secret = env.CRON_SECRET ?? env.JOBS_TICK_SECRET;
  return secret === undefined
    ? undefined
    : new HttpHelpRevalidator({
        origin: resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL }),
        secret,
      });
}
