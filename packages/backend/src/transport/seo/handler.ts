// Production wiring for /robots.txt and /sitemap.xml (#363) and for llms.txt and the pages'
// Markdown (#366): binds seoFile and agentFile to the env and the help center's public read.
// The frontend's API routes call these with the request host.
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { getHelpDomain, helpIndexNowKeyFor } from '@backend/domain/helpcenter/instance';
import { helpSiteForHost, helpSiteOrigin } from '@backend/domain/helpcenter/site-url';
import { getEnv } from '@backend/infra/config/env';
import { agentFile } from '@backend/transport/seo/agents';
import { seoFile } from '@backend/transport/seo/files';
import { changelogRss } from '@backend/transport/sites/changelog-rss';
import { feedbackPages } from '@backend/transport/sites/feedback';

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
    indexNowKeyOf: helpIndexNowKeyFor,
    feedbackPages: async slug => await feedbackPages().sitemapPages(slug),
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

/** A public board's changelog as RSS for the request's host (#176): 404 off a help site, or for a
 * private or missing board. */
export async function changelogRssFor(host: string, boardSlug: string): Promise<SeoFileResponse> {
  const env = getEnv();
  const notFound = { status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not found\n' } as const;
  const site = helpSiteForHost(host, env);
  const origin = site === null ? null : helpSiteOrigin(site, env);
  if (site === null || origin === null) {
    return notFound;
  }
  const page = await feedbackPages().changelogPage(site, boardSlug);
  if (page === undefined) {
    return notFound;
  }
  return {
    status: 200,
    contentType: 'application/rss+xml; charset=utf-8',
    body: changelogRss({ origin, siteName: page.site.name, board: page.board, entries: page.entries }),
  };
}
