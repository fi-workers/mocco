import { HELP_LOCALE_NAMES } from '@mocco/common/help';

import DocContent from '@frontend/components/doc-content';
import HelpSiteLayout from '@frontend/components/help/help-site-layout';
import HelpfulWidget from '@frontend/components/help/helpful-widget';
import { HELP_REVALIDATE_SECONDS, loadHelpArticle, loadHelpNav } from '@frontend/lib/help-site';
import { wordsFor } from '@frontend/lib/help-site-words';
import { helpArticleCard } from '@frontend/lib/og-card';
import { breadcrumbLd, helpArticleLd } from '@frontend/lib/seo';

import type { DocBlock } from '@frontend/lib/doc-ast';
import type { HelpSiteNav } from '@frontend/lib/help-site';
import type { GetStaticPaths, GetStaticProps } from 'next';

interface Props {
  nav: HelpSiteNav;
  article: {
    shortId: string;
    title: string;
    canonicalPath: string;
    description: string;
    versions: { locale: string; path: string }[];
    sourcePath: string;
    sourceLocale: string;
    /** About the served translation; null on the source. */
    translation: { isMachine: boolean; isStale: boolean } | null;
    publishedAt: string | null;
    modifiedAt: string | null;
    blocks: DocBlock[];
  };
  /** The article's share card, or null when cards can't be issued. */
  card: string | null;
}

// One help article. A stale slug redirects permanently to the article's canonical path; a
// language the article isn't translated into redirects there for now (a translation may
// come). Statically generated on first request (ISR, ADR 0015).
export const getStaticPaths: GetStaticPaths = () => ({ paths: [], fallback: 'blocking' });

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => {
  const site = typeof params?.site === 'string' ? params.site : '';
  const locale = typeof params?.locale === 'string' ? params.locale : '';
  const ref = typeof params?.ref === 'string' ? params.ref : '';
  const article = await loadHelpArticle(site, locale, ref);
  const nav = article === undefined ? undefined : await loadHelpNav(site, article.locale);
  if (article === undefined || nav === undefined) {
    return { notFound: true, revalidate: HELP_REVALIDATE_SECONDS };
  }
  if (article.canonicalPath !== `/${locale}/articles/${ref}`) {
    return {
      redirect: { destination: article.canonicalPath, permanent: article.locale === locale },
      revalidate: HELP_REVALIDATE_SECONDS,
    };
  }
  const collection = nav.collections.find(entry =>
    entry.sections.some(section => section.articles.some(item => item.path === article.canonicalPath)),
  );
  const card = helpArticleCard({
    siteName: nav.name,
    eyebrow: collection?.title ?? null,
    title: article.title,
    description: article.description,
  });
  return {
    props: {
      card,
      nav,
      article: {
        shortId: article.shortId,
        title: article.title,
        canonicalPath: article.canonicalPath,
        description: article.description,
        versions: article.versions,
        sourcePath: article.sourcePath,
        sourceLocale: article.sourceLocale,
        translation: article.translation,
        publishedAt: article.publishedAt,
        modifiedAt: article.modifiedAt,
        blocks: article.blocks,
      },
    },
    revalidate: HELP_REVALIDATE_SECONDS,
  };
};

export default function HelpArticlePage({ nav, article, card }: Props) {
  const words = wordsFor(nav.locale);
  const sourceName = (HELP_LOCALE_NAMES as Record<string, string>)[article.sourceLocale] ?? article.sourceLocale;
  return (
    <HelpSiteLayout
      nav={nav}
      title={article.title}
      currentPath={article.canonicalPath}
      // This article in each language it is served in; a language without it goes to its home.
      languages={nav.locales.map(locale => ({
        locale,
        path: article.versions.find(version => version.locale === locale)?.path ?? `/${locale}`,
      }))}
      seo={{
        path: article.canonicalPath,
        description: article.description,
        versions: article.versions,
        type: 'article',
        hasMarkdown: true,
        card,
        jsonLd: origin => [
          breadcrumbLd(origin, [
            { name: nav.name, path: `/${nav.locale}` },
            { name: article.title, path: article.canonicalPath },
          ]),
          helpArticleLd(origin, {
            path: article.canonicalPath,
            title: article.title,
            description: article.description,
            locale: nav.locale,
            siteName: nav.name,
            publishedAt: article.publishedAt,
            modifiedAt: article.modifiedAt,
          }),
        ],
      }}>
      <article className="flex max-w-3xl flex-col gap-4">
        {article.translation?.isStale === true ? (
          // The site's stale policy (serve the older translation with a banner): say so, and link the source.
          <p role="note" className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            {words.sourceChanged}{' '}
            <a
              href={article.sourcePath}
              hrefLang={article.sourceLocale}
              className="font-medium text-foreground underline">
              {words.readOriginal(sourceName)}
            </a>
          </p>
        ) : null}
        <h1 className="text-3xl font-semibold tracking-tight">{article.title}</h1>
        {article.translation?.isMachine === true ? (
          <p className="-mt-2 text-xs text-muted-foreground">{words.machineTranslated}</p>
        ) : null}
        <DocContent blocks={article.blocks} />
        <HelpfulWidget site={nav.slug} article={article.shortId} locale={nav.locale} words={words} />
      </article>
    </HelpSiteLayout>
  );
}
