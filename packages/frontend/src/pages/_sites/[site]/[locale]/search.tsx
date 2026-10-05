import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

import HelpSiteLayout from '@frontend/components/help/help-site-layout';
import { HELP_REVALIDATE_SECONDS, loadHelpNav } from '@frontend/lib/help-site';
import { wordsFor } from '@frontend/lib/help-site-words';

import type { HelpSiteNav } from '@frontend/lib/help-site';
import type { GetStaticPaths, GetStaticProps } from 'next';

interface Props {
  nav: HelpSiteNav;
}

interface Hit {
  title: string;
  path: string;
  snippet: string;
}

// A help center's search results (#96). The frame is static (ISR, ADR 0015); the
// results come from /api/help/search in the browser, for the `?q=` in the address.
export const getStaticPaths: GetStaticPaths = () => ({ paths: [], fallback: 'blocking' });

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => {
  const site = typeof params?.site === 'string' ? params.site : '';
  const locale = typeof params?.locale === 'string' ? params.locale : '';
  const nav = await loadHelpNav(site, locale);
  if (nav === undefined) {
    return { notFound: true, revalidate: HELP_REVALIDATE_SECONDS };
  }
  return { props: { nav }, revalidate: HELP_REVALIDATE_SECONDS };
};

export default function HelpSearchPage({ nav }: Props) {
  const router = useRouter();
  const query = typeof router.query.q === 'string' ? router.query.q : '';
  const [hits, setHits] = useState<Hit[] | null>(null);
  const words = wordsFor(nav.locale);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (query === '') {
        return;
      }
      const params = new URLSearchParams({ site: nav.slug, locale: nav.locale, q: query });
      try {
        const response = await fetch(`/api/help/search?${params.toString()}`, { signal: controller.signal });
        const result = (await response.json()) as { hits: Hit[] };
        setHits(result.hits);
      } catch {
        // Aborted, or offline: the page shows nothing new.
      }
    };
    // eslint-disable-next-line no-void -- an effect can't await; load() never rejects
    void load();
    return () => {
      controller.abort();
    };
  }, [nav.slug, nav.locale, query]);

  return (
    <HelpSiteLayout nav={nav} title={words.search} noindex>
      <div className="flex max-w-3xl flex-col gap-6">
        <form method="get" role="search" className="flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={query}
            aria-label={words.search}
            placeholder={words.searchPlaceholder}
            className="h-10 flex-1 rounded-md border border-border bg-background px-3"
          />
          <button type="submit" className="h-10 rounded-md bg-foreground px-4 text-sm font-medium text-background">
            {words.search}
          </button>
        </form>
        {query === '' ? null : <h1 className="text-xl font-semibold tracking-tight">{words.resultsFor(query)}</h1>}
        {hits !== null && hits.length === 0 ? <p className="text-muted-foreground">{words.noResults}</p> : null}
        <ul className="flex flex-col gap-4">
          {(hits ?? []).map(hit => (
            <li key={hit.path} className="flex flex-col gap-1">
              <a href={hit.path} className="font-medium underline-offset-2 hover:underline">
                {hit.title}
              </a>
              <p className="text-sm text-muted-foreground">{hit.snippet}</p>
            </li>
          ))}
        </ul>
      </div>
    </HelpSiteLayout>
  );
}
