// Production wiring for /robots.txt and /sitemap.xml (#363) and for llms.txt and the pages'
// Markdown (#366): binds seoFile and agentFile to the env and the help center's public read.
// The frontend's API routes call these with the request host.
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { getHelpDomain } from '@backend/domain/helpcenter/instance';
import { helpSiteForHost, helpSiteOrigin } from '@backend/domain/helpcenter/site-url';
import { getEnv } from '@backend/infra/config/env';
import { agentFile } from '@backend/transport/seo/agents';
import { seoFile } from '@backend/transport/seo/files';

import type { AgentFileRequest, GuideSetForAgents } from '@backend/transport/seo/agents';
import type { AppPage, SeoFile, SeoFileResponse } from '@backend/transport/seo/files';

export { AgentFiles } from '@backend/transport/seo/agents';
export { SeoFiles } from '@backend/transport/seo/files';
export type { AgentFile, GuideSetForAgents } from '@backend/transport/seo/agents';
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

/** llms.txt, llms-full.txt or one page's Markdown for the request's host (#366). */
export async function agentFileFor(
  host: string,
  request: AgentFileRequest,
  guides: () => readonly GuideSetForAgents[],
): Promise<SeoFileResponse> {
  const env = getEnv();
  return await agentFile(host, request, {
    appOrigin: resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL }),
    guides,
    helpSiteForHost: requestHost => helpSiteForHost(requestHost, env),
    helpSiteOrigin: slug => helpSiteOrigin(slug, env),
    help: getHelpDomain().helpPublic,
  });
}
