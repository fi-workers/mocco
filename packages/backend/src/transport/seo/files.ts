// What /robots.txt and /sitemap.xml answer on each host (#363). The app's host lists the
// public pages the frontend names (the landing and the customer guides) and keeps crawlers
// out of the signed-in console; a help center's host lists that site's published pages in
// every language they are served in, under the site's canonical origin (its custom domain
// when it has one), and keeps AI training crawlers out when the site says so. Pure over
// its inputs, so the Next route stays a thin adapter.

import { HelpSiteNotFoundError } from '@backend/domain/helpcenter/errors';
import { AI_TRAINING_CRAWLERS, robotsTxt } from '@backend/transport/seo/robots';
import { sitemapXml, withLanguageVersions } from '@backend/transport/seo/sitemap';

import type { HelpPublicReadService } from '@backend/domain/helpcenter/HelpPublicReadService';

export const SeoFiles = { robots: 'robots', sitemap: 'sitemap', indexNowKey: 'indexnow' } as const;
export type SeoFile = (typeof SeoFiles)[keyof typeof SeoFiles];

/** A public page of the app: a path and when it last changed, if known. */
export interface AppPage {
  path: string;
  lastModified?: Date | null;
}

export interface SeoFileResponse {
  status: number;
  contentType: string;
  body: string;
}

/** The console and auth screens: nothing there is public. */
const APP_PRIVATE_PATHS = ['/workspaces', '/account', '/auth/', '/api/'];
/** A help center's search results render in the browser; an empty page isn't worth indexing. */
const HELP_PRIVATE_PATHS = ['/*/search'];

const TEXT = 'text/plain; charset=utf-8';
const XML = 'application/xml; charset=utf-8';

export interface SeoFileDeps {
  /** The app's own origin, e.g. https://www.mocco.club. */
  appOrigin: string;
  appPages: () => readonly AppPage[];
  /** The help site a host serves, or null for the app's own host. */
  helpSiteForHost: (host: string) => string | null;
  /** A help site's canonical origin, or null when help centers aren't served. */
  helpSiteOrigin: (slug: string) => string | null;
  help: Pick<HelpPublicReadService, 'site' | 'sitemap'>;
  /** A help site's IndexNow key (#367), or null when none can be derived. */
  indexNowKeyOf: (slug: string) => string | null;
}

export async function seoFile(file: SeoFile, host: string, deps: SeoFileDeps): Promise<SeoFileResponse> {
  const slug = deps.helpSiteForHost(host);
  if (file === SeoFiles.indexNowKey) {
    // Only help sites submit to IndexNow; the app's host has no key.
    const key = slug === null ? null : deps.indexNowKeyOf(slug);
    return key === null
      ? { status: 404, contentType: TEXT, body: 'Not found\n' }
      : { status: 200, contentType: TEXT, body: key };
  }
  if (slug === null) {
    if (file === SeoFiles.robots) {
      return {
        status: 200,
        contentType: TEXT,
        body: robotsTxt({ disallow: APP_PRIVATE_PATHS, sitemap: `${deps.appOrigin}/sitemap.xml` }),
      };
    }
    const pages = deps
      .appPages()
      .map(page => ({ loc: `${deps.appOrigin}${page.path}`, lastModified: page.lastModified }));
    return { status: 200, contentType: XML, body: sitemapXml(pages) };
  }
  const origin = deps.helpSiteOrigin(slug);
  if (origin === null) {
    return { status: 404, contentType: TEXT, body: 'Not found\n' };
  }
  try {
    if (file === SeoFiles.robots) {
      const site = await deps.help.site(slug);
      return {
        status: 200,
        contentType: TEXT,
        body: robotsTxt({
          disallow: HELP_PRIVATE_PATHS,
          sitemap: `${origin}/sitemap.xml`,
          blocked: site.allowAiTraining ? [] : AI_TRAINING_CRAWLERS,
        }),
      };
    }
    const map = await deps.help.sitemap(slug);
    const pages = withLanguageVersions(origin, [map.homes, ...map.articles], map.sourceLocale);
    return { status: 200, contentType: XML, body: sitemapXml(pages) };
  } catch (error) {
    if (error instanceof HelpSiteNotFoundError) {
      return { status: 404, contentType: TEXT, body: 'Not found\n' };
    }
    throw error;
  }
}
