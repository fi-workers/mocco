// Production wiring for /robots.txt and /sitemap.xml (#363): binds seoFile to the env and
// the help center's public read. The frontend's API route calls this with the request host.
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { getHelpDomain } from '@backend/domain/helpcenter/instance';
import { helpSiteForHost, helpSiteOrigin } from '@backend/domain/helpcenter/site-url';
import { getEnv } from '@backend/infra/config/env';
import { seoFile } from '@backend/transport/seo/files';

import type { AppPage, SeoFile, SeoFileResponse } from '@backend/transport/seo/files';

export { SeoFiles } from '@backend/transport/seo/files';
export type { AppPage, SeoFile } from '@backend/transport/seo/files';

export async function seoFileFor(
  file: SeoFile,
  host: string,
  appPages: () => readonly AppPage[],
): Promise<SeoFileResponse> {
  const env = getEnv();
  return await seoFile(file, host, {
    appOrigin: resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL }),
    appPages,
    helpSiteForHost: requestHost => helpSiteForHost(requestHost, env),
    helpSiteOrigin: slug => helpSiteOrigin(slug, env),
    help: getHelpDomain().helpPublic,
  });
}
