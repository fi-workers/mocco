// The frame of a public help center (pages/_sites/**): the site's name, a language
// switcher (to the same page in each language where it exists, else that language's home)
// and the article tree. Links are plain anchors: the pages are served on the
// site's own host, where paths are `/{locale}/...`.
import { HELP_LOCALE_NAMES } from '@mocco/common/help';
import Head from 'next/head';

import SeoHead from '@frontend/components/seo-head';
import { wordsFor } from '@frontend/lib/help-site-words';
import { cn } from '@frontend/lib/utils';

import type { HelpSiteNav } from '@frontend/lib/help-site';
import type { ReactNode } from 'react';

export default function HelpSiteLayout({
  nav,
  title,
  currentPath,
  languages,
  seo,
  noindex = false,
  children,
}: {
  nav: HelpSiteNav;
  title: string;
  currentPath?: string;
  /** Where the switcher sends each language; each language's home without it. */
  languages?: readonly { locale: string; path: string }[];
  /**
   * What search engines and link previews get: this page's path, a description, the page in
   * every language it exists in, and JSON-LD. Canonical and hreflang URLs are absolute on the
   * site's own origin (its custom domain when it has one).
   */
  seo?: {
    path: string;
    description: string;
    versions: readonly { locale: string; path: string }[];
    type?: 'website' | 'article';
    /** The page has a Markdown version at `<path>.md` (articles). */
    hasMarkdown?: boolean;
    /** The page's share card, an issued `/og/v1/...` path on the site's origin; none when null. */
    card: string | null;
    jsonLd?: (origin: string) => readonly Record<string, unknown>[];
  };
  /** Keep the page out of search (the search results page: empty to a crawler). */
  noindex?: boolean;
  children: ReactNode;
}) {
  const fullTitle = title === nav.name ? title : `${title} · ${nav.name}`;
  const { origin } = nav;
  const source = nav.locales[0];
  const switcher = languages ?? nav.locales.map(locale => ({ locale, path: `/${locale}` }));
  return (
    <>
      {seo === undefined || origin === null ? (
        <Head>
          <title key="title">{fullTitle}</title>
          <meta key="robots" name="robots" content={noindex ? 'noindex, follow' : 'index, follow'} />
        </Head>
      ) : (
        <SeoHead
          title={fullTitle}
          description={seo.description}
          url={`${origin}${seo.path}`}
          origin={origin}
          type={seo.type ?? 'website'}
          siteName={nav.name}
          locale={nav.locale}
          withImage={seo.card !== null}
          image={seo.card === null ? null : { path: seo.card, alt: fullTitle }}
          noindex={noindex}
          {...(seo.hasMarkdown === true && { markdownUrl: `${origin}${seo.path}.md` })}
          alternates={
            seo.versions.length < 2
              ? []
              : [
                  ...seo.versions.map(version => ({ hreflang: version.locale, href: `${origin}${version.path}` })),
                  ...seo.versions
                    .filter(version => version.locale === source)
                    .map(version => ({ hreflang: 'x-default', href: `${origin}${version.path}` })),
                ]
          }
          jsonLd={seo.jsonLd?.(origin) ?? []}
        />
      )}
      <div lang={nav.locale} className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="flex h-14 items-center justify-between gap-4 border-b border-border px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <a href={`/${nav.locale}`} className="shrink-0 font-semibold tracking-tight">
              {nav.name}
            </a>
            <form action={`/${nav.locale}/search`} method="get" role="search" className="hidden sm:block">
              <input
                type="search"
                name="q"
                aria-label={wordsFor(nav.locale).search}
                placeholder={wordsFor(nav.locale).searchPlaceholder}
                className="h-8 w-56 rounded-md border border-border bg-background px-2.5 text-sm"
              />
            </form>
          </div>
          {switcher.length > 1 ? (
            <nav aria-label={wordsFor(nav.locale).language} className="flex flex-wrap items-center gap-1 text-sm">
              {switcher.map(({ locale, path }) => (
                <a
                  key={locale}
                  href={path}
                  hrefLang={locale}
                  lang={locale}
                  aria-current={locale === nav.locale ? 'true' : undefined}
                  className={cn(
                    'rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground',
                    locale === nav.locale && 'bg-muted font-medium text-foreground',
                  )}>
                  {(HELP_LOCALE_NAMES as Record<string, string>)[locale] ?? locale}
                </a>
              ))}
            </nav>
          ) : null}
        </header>
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 md:flex-row md:px-6 md:py-10">
          <nav aria-label="Articles" className="flex shrink-0 flex-col gap-6 md:w-60">
            {nav.collections.map(collection => (
              <div key={collection.slug} className="flex flex-col gap-3">
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {collection.title}
                </p>
                {collection.sections.map(section => (
                  <div key={section.title} className="flex flex-col gap-1">
                    <p className="px-2 text-sm font-medium">{section.title}</p>
                    <ul className="flex flex-col gap-0.5">
                      {section.articles.map(article => (
                        <li key={article.path}>
                          <a
                            href={article.path}
                            aria-current={article.path === currentPath ? 'page' : undefined}
                            className={cn(
                              'block rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground',
                              article.path === currentPath && 'bg-muted font-medium text-foreground',
                            )}>
                            {article.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </nav>
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </>
  );
}
