import DocContent from '@frontend/components/doc-content';
import HelpSiteLayout from '@frontend/components/help/help-site-layout';
import { HELP_REVALIDATE_SECONDS, loadHelpArticle, loadHelpNav } from '@frontend/lib/help-site';

import type { DocBlock } from '@frontend/lib/doc-ast';
import type { HelpSiteNav } from '@frontend/lib/help-site';
import type { GetStaticPaths, GetStaticProps } from 'next';

interface Props {
  nav: HelpSiteNav;
  article: { title: string; canonicalPath: string; blocks: DocBlock[] };
}

// One help article. A stale slug or a language the site doesn't have redirects to the
// article's canonical path. Statically generated on first request (ISR, ADR 0025).
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
    return { redirect: { destination: article.canonicalPath, permanent: false }, revalidate: HELP_REVALIDATE_SECONDS };
  }
  return {
    props: { nav, article: { title: article.title, canonicalPath: article.canonicalPath, blocks: article.blocks } },
    revalidate: HELP_REVALIDATE_SECONDS,
  };
};

export default function HelpArticlePage({ nav, article }: Props) {
  return (
    <HelpSiteLayout nav={nav} title={article.title} currentPath={article.canonicalPath}>
      <article className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">{article.title}</h1>
        <DocContent blocks={article.blocks} />
      </article>
    </HelpSiteLayout>
  );
}
