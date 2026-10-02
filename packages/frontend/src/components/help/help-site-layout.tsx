// The frame of a public help center (pages/_sites/**): the site's name, a language
// switcher and the article tree. Links are plain anchors: the pages are served on the
// site's own host, where paths are `/{locale}/...`.
import { HELP_LOCALE_NAMES } from '@mocco/common/help';
import Head from 'next/head';

import { cn } from '@frontend/lib/utils';

import type { HelpSiteNav } from '@frontend/lib/help-site';
import type { ReactNode } from 'react';

export default function HelpSiteLayout({
  nav,
  title,
  currentPath,
  children,
}: {
  nav: HelpSiteNav;
  title: string;
  currentPath?: string;
  children: ReactNode;
}) {
  return (
    <>
      <Head>
        <title>{title === nav.name ? title : `${title} · ${nav.name}`}</title>
        <meta name="robots" content="index, follow" />
      </Head>
      <div lang={nav.locale} className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="flex h-14 items-center justify-between gap-4 border-b border-border px-4 md:px-6">
          <a href={`/${nav.locale}`} className="font-semibold tracking-tight">
            {nav.name}
          </a>
          {nav.locales.length > 1 ? (
            <nav aria-label="Language" className="flex flex-wrap items-center gap-1 text-sm">
              {nav.locales.map(locale => (
                <a
                  key={locale}
                  href={`/${locale}`}
                  hrefLang={locale}
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
