// Server-side data for the public help center pages (pages/_sites/**): reads the published
// site through the backend's public-read service and turns article Markdown into the
// render tree. Only getStaticProps calls it; nothing here reaches the browser bundle.
import { getHelpDomain, helpSiteOriginFor } from '@mocco/backend/helpcenter/instance';
import { articlePath } from '@mocco/common/help';

import { helpArticleBlocks } from '@frontend/lib/help-markdown';
import { excerptOf } from '@frontend/lib/seo';

import type { DocBlock } from '@frontend/lib/doc-ast';

export interface HelpSiteNav {
  slug: string;
  name: string;
  /** Where the site is served — its custom domain, else its Mocco subdomain — or null when help sites aren't served. */
  origin: string | null;
  locale: string;
  locales: string[];
  collections: {
    slug: string;
    title: string;
    sections: { title: string; articles: { title: string; path: string }[] }[];
  }[];
}

/** Pages regenerate at most this often after a request (ISR). */
export const HELP_REVALIDATE_SECONDS = 60;

/** A missing site is a 404, not a build error. */
const isMissingSite = (error: unknown) => error instanceof Error && error.name === 'HelpSiteNotFoundError';

/** The site and its published tree in `locale`, or undefined when there is no such site. */
export async function loadHelpNav(site: string, locale: string): Promise<HelpSiteNav | undefined> {
  const { helpPublic } = getHelpDomain();
  try {
    const info = await helpPublic.site(site);
    const tree = await helpPublic.tree(site, locale);
    return {
      slug: info.slug,
      name: info.name,
      origin: helpSiteOriginFor(info.slug),
      locale: tree.locale,
      locales: [info.sourceLocale, ...info.locales],
      collections: tree.collections.map(collection => ({
        slug: collection.slug,
        title: collection.title,
        sections: collection.sections.map(section => ({
          title: section.title,
          articles: section.articles.map(article => ({ title: article.title, path: article.path })),
        })),
      })),
    };
  } catch (error) {
    if (isMissingSite(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function loadHelpArticle(site: string, locale: string, ref: string) {
  const { helpPublic } = getHelpDomain();
  try {
    const article = await helpPublic.article(site, locale, ref);
    if (article === undefined) {
      return undefined;
    }
    const blocks: DocBlock[] = helpArticleBlocks(article.body);
    return {
      shortId: article.shortId,
      title: article.title,
      locale: article.locale,
      canonicalPath: article.canonicalPath,
      // The address of this article in each language it is served in.
      versions: article.locales.map(served => ({
        locale: served,
        path: articlePath(served, article.shortId, article.slug),
      })),
      description: excerptOf(blocks),
      publishedAt: article.publishedAt?.toISOString() ?? null,
      modifiedAt: article.modifiedAt?.toISOString() ?? null,
      blocks,
    };
  } catch (error) {
    if (isMissingSite(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Where an old path now lives, or undefined (no such site or path). */
export async function loadHelpRedirect(site: string, fromPath: string): Promise<string | undefined> {
  try {
    return await getHelpDomain().helpPublic.redirect(site, fromPath);
  } catch (error) {
    if (isMissingSite(error)) {
      return undefined;
    }
    throw error;
  }
}
