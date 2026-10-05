import Image from 'next/image';
import Link from 'next/link';

import DocContent from '@frontend/components/doc-content';
import SeoHead from '@frontend/components/seo-head';
import { listGuides, listGuideSlugs, readGuidePage } from '@frontend/lib/customer-docs';
import { guideSetLabels, guideSetSchema, GuideSets } from '@frontend/lib/guide-sets';
import { Routes } from '@frontend/lib/routes';
import { breadcrumbLd, organizationLd, siteOrigin, techArticleLd, websiteLd } from '@frontend/lib/seo';
import { cn } from '@frontend/lib/utils';

import type { DocNavEntry, DocPage } from '@frontend/lib/doc-ast';
import type { GuideSet } from '@frontend/lib/guide-sets';
import type { GetStaticPaths, GetStaticProps } from 'next';

interface Props {
  set: GuideSet;
  page: DocPage;
  nav: DocNavEntry[];
}

// The customer guides, one set per product area (notifications, ota), statically
// generated from docs/customer/<set>/*.md at build time. Public pages, like the landing:
// no session, no tRPC, and nothing is read at request time.
export const getStaticPaths: GetStaticPaths = () => ({
  paths: Object.values(GuideSets).flatMap(set => listGuideSlugs(set).map(page => ({ params: { set, page } }))),
  fallback: false,
});

export const getStaticProps: GetStaticProps<Props> = ({ params }) => {
  const set = guideSetSchema.parse(params?.set);
  const slug = typeof params?.page === 'string' ? params.page : '';
  return { props: { set, page: readGuidePage(set, slug), nav: listGuides(set) } };
};

export default function GuidePage({ set, page, nav }: Props) {
  const origin = siteOrigin();
  const path = Routes.guide(set, page.slug);
  const first = nav[0]?.slug ?? page.slug;
  return (
    <>
      <SeoHead
        title={`${page.title} · Mocco docs`}
        description={page.description}
        url={`${origin}${path}`}
        origin={origin}
        type="article"
        jsonLd={[
          organizationLd(origin),
          websiteLd(origin),
          breadcrumbLd(origin, [
            { name: 'Mocco', path: '/' },
            { name: guideSetLabels[set], path: Routes.guide(set, first) },
            { name: page.title, path },
          ]),
          techArticleLd(origin, { path, title: page.title, description: page.description, updated: page.updated }),
        ]}
      />
      <div className="flex min-h-screen flex-col">
        <header className="flex h-14 items-center gap-2 border-b border-border px-4">
          <Link href={Routes.home} className="flex items-center gap-2" aria-label="Mocco home">
            <Image src="/favicon/favicon.svg" alt="" width={28} height={28} className="size-7" />
            <span className="font-semibold tracking-tight">Mocco</span>
          </Link>
          <span aria-hidden="true" className="text-lg text-border">
            /
          </span>
          <span className="text-sm text-muted-foreground">Docs</span>
        </header>
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10 md:flex-row">
          <nav aria-label={`${guideSetLabels[set]} guides`} className="shrink-0 md:w-56">
            <p className="mb-2 px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {guideSetLabels[set]}
            </p>
            <ul className="flex flex-col gap-0.5">
              {nav.map(entry => (
                <li key={entry.slug}>
                  <Link
                    href={Routes.guide(set, entry.slug)}
                    aria-current={entry.slug === page.slug ? 'page' : undefined}
                    className={cn(
                      'block rounded-lg px-2 py-1.5 text-sm transition',
                      entry.slug === page.slug
                        ? 'bg-muted font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}>
                    {entry.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <main className="flex min-w-0 max-w-3xl flex-1 flex-col gap-4 text-[15px] text-foreground/85">
            <DocContent blocks={page.blocks} />
          </main>
        </div>
      </div>
    </>
  );
}
