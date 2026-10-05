import Image from 'next/image';
import Link from 'next/link';

import SeoHead from '@frontend/components/seo-head';
import { listGuides } from '@frontend/lib/customer-docs';
import { guideSetLabels, GuideSets } from '@frontend/lib/guide-sets';
import { moccoSimpleCard } from '@frontend/lib/og-card';
import { Routes } from '@frontend/lib/routes';
import { breadcrumbLd, organizationLd, siteOrigin, websiteLd } from '@frontend/lib/seo';

import type { DocNavEntry } from '@frontend/lib/doc-ast';
import type { GuideSet } from '@frontend/lib/guide-sets';
import type { GetStaticProps } from 'next';

interface Props {
  sets: { set: GuideSet; guides: DocNavEntry[] }[];
  card: string | null;
}

// Every customer guide set and its guides on one page, statically generated like the guides.
export const getStaticProps: GetStaticProps<Props> = () => ({
  props: {
    sets: Object.values(GuideSets).map(set => ({ set, guides: listGuides(set) })),
    card: moccoSimpleCard({ title: 'Mocco docs', subtitle: 'Guides for every product, and for agents as Markdown' }),
  },
});

const DESCRIPTION =
  'Guides for every Mocco product: deploy governance, OTA updates, feature flags, the status page, notifications, the messenger, the help center and connecting agents over MCP.';

export default function DocsIndex({ sets, card }: Props) {
  const origin = siteOrigin();
  return (
    <>
      <SeoHead
        title="Mocco docs"
        description={DESCRIPTION}
        url={`${origin}${Routes.docs}`}
        origin={origin}
        markdownUrl={`${origin}/llms.txt`}
        image={card === null ? null : { path: card, alt: 'Mocco docs' }}
        jsonLd={[
          organizationLd(origin),
          websiteLd(origin),
          breadcrumbLd(origin, [
            { name: 'Mocco', path: '/' },
            { name: 'Docs', path: Routes.docs },
          ]),
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
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight">Mocco docs</h1>
            <p className="max-w-prose text-muted-foreground">{DESCRIPTION}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sets.map(({ set, guides }) => (
              <section key={set} className="flex flex-col gap-2 rounded-xl border border-border p-4">
                <h2 className="font-medium">{guideSetLabels[set]}</h2>
                <ul className="flex flex-col gap-1 text-sm">
                  {guides.map(guide => (
                    <li key={guide.slug}>
                      <Link
                        href={Routes.guide(set, guide.slug)}
                        className="text-muted-foreground hover:text-foreground hover:underline">
                        {guide.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </main>
      </div>
    </>
  );
}
