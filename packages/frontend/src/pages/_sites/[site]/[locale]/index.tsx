import HelpSiteLayout from '@frontend/components/help/help-site-layout';
import { HELP_REVALIDATE_SECONDS, loadHelpNav } from '@frontend/lib/help-site';
import { helpHomeCard } from '@frontend/lib/og-card';

import type { HelpSiteNav } from '@frontend/lib/help-site';
import type { GetStaticPaths, GetStaticProps } from 'next';

interface Props {
  nav: HelpSiteNav;
  card: string | null;
}

// A help center's home in one language: every collection with its articles. Statically
// generated on first request and refreshed in the background (ISR, ADR 0015).
export const getStaticPaths: GetStaticPaths = () => ({ paths: [], fallback: 'blocking' });

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => {
  const site = typeof params?.site === 'string' ? params.site : '';
  const locale = typeof params?.locale === 'string' ? params.locale : '';
  const nav = await loadHelpNav(site, locale);
  if (nav === undefined) {
    return { notFound: true, revalidate: HELP_REVALIDATE_SECONDS };
  }
  if (nav.locale !== locale) {
    return { redirect: { destination: `/${nav.locale}`, permanent: false }, revalidate: HELP_REVALIDATE_SECONDS };
  }
  const card = helpHomeCard({ siteName: nav.name, collections: nav.collections.map(collection => collection.title) });
  return { props: { nav, card }, revalidate: HELP_REVALIDATE_SECONDS };
};

export default function HelpSiteHome({ nav, card }: Props) {
  return (
    <HelpSiteLayout
      nav={nav}
      title={nav.name}
      seo={{
        path: `/${nav.locale}`,
        description: nav.collections.map(collection => collection.title).join(' · '),
        versions: nav.locales.map(locale => ({ locale, path: `/${locale}` })),
        card,
        jsonLd: origin => [{ '@type': 'WebSite', name: nav.name, url: `${origin}/`, inLanguage: nav.locales }],
      }}>
      <div className="flex flex-col gap-10">
        <h1 className="text-3xl font-semibold tracking-tight">{nav.name}</h1>
        {nav.collections.map(collection => (
          <section key={collection.slug} className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold tracking-tight">{collection.title}</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {collection.sections.map(section => (
                <div key={section.title} className="flex flex-col gap-2 rounded-xl border border-border p-4">
                  <h3 className="font-medium">{section.title}</h3>
                  <ul className="flex flex-col gap-1 text-sm">
                    {section.articles.map(article => (
                      <li key={article.path}>
                        <a href={article.path} className="text-muted-foreground hover:text-foreground hover:underline">
                          {article.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </HelpSiteLayout>
  );
}
