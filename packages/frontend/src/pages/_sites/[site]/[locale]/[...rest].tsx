import { HELP_REVALIDATE_SECONDS, loadHelpRedirect } from '@frontend/lib/help-site';

import type { GetStaticPaths, GetStaticProps } from 'next';

// Any other path on a help center's host: an old URL (an imported site's page, such as
// /features/widget-features) redirects to the article it became; anything else is a 404.
export const getStaticPaths: GetStaticPaths = () => ({ paths: [], fallback: 'blocking' });

export const getStaticProps: GetStaticProps = async ({ params }) => {
  const site = typeof params?.site === 'string' ? params.site : '';
  const first = typeof params?.locale === 'string' ? params.locale : '';
  const rest = Array.isArray(params?.rest) ? params.rest : [];
  const destination = await loadHelpRedirect(site, `/${[first, ...rest].join('/')}`);
  if (destination === undefined) {
    return { notFound: true, revalidate: HELP_REVALIDATE_SECONDS };
  }
  return { redirect: { destination, permanent: true }, revalidate: HELP_REVALIDATE_SECONDS };
};

export default function HelpSiteRedirect() {
  return null;
}
