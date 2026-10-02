import { HELP_REVALIDATE_SECONDS, loadHelpNav } from '@frontend/lib/help-site';

import type { GetStaticPaths, GetStaticProps } from 'next';

// A help center's root: send the reader to the source language's home.
export const getStaticPaths: GetStaticPaths = () => ({ paths: [], fallback: 'blocking' });

export const getStaticProps: GetStaticProps = async ({ params }) => {
  const site = typeof params?.site === 'string' ? params.site : '';
  const nav = await loadHelpNav(site, '');
  if (nav === undefined) {
    return { notFound: true, revalidate: HELP_REVALIDATE_SECONDS };
  }
  return { redirect: { destination: `/${nav.locale}`, permanent: false }, revalidate: HELP_REVALIDATE_SECONDS };
};

export default function HelpSiteRoot() {
  return null;
}
