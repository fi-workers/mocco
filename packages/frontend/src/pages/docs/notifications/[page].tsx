import Head from 'next/head';
import Image from 'next/image';
import Link from 'next/link';

import DocContent from '@frontend/components/doc-content';
import { listGuides, listGuideSlugs, readGuidePage } from '@frontend/lib/customer-docs';
import { Routes } from '@frontend/lib/routes';
import { cn } from '@frontend/lib/utils';

import type { DocNavEntry, DocPage } from '@frontend/lib/doc-ast';
import type { GetStaticPaths, GetStaticProps } from 'next';

interface Props {
  page: DocPage;
  nav: DocNavEntry[];
}

// The customer guides for notifications (relay design §10), statically generated from
// docs/customer/notifications/*.md at build time. Public pages, like the landing: no
// session, no tRPC, and nothing is read at request time.
export const getStaticPaths: GetStaticPaths = () => ({
  paths: listGuideSlugs().map(page => ({ params: { page } })),
  fallback: false,
});

export const getStaticProps: GetStaticProps<Props> = ({ params }) => {
  const slug = typeof params?.page === 'string' ? params.page : '';
  return { props: { page: readGuidePage(slug), nav: listGuides() } };
};

export default function NotificationGuidePage({ page, nav }: Props) {
  return (
    <>
      <Head>
        <title>{`${page.title} · Mocco docs`}</title>
        <meta name="description" content={page.description} />
      </Head>
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
          <nav aria-label="Notifications guides" className="shrink-0 md:w-56">
            <p className="mb-2 px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Notifications
            </p>
            <ul className="flex flex-col gap-0.5">
              {nav.map(entry => (
                <li key={entry.slug}>
                  <Link
                    href={Routes.notificationsGuide(entry.slug)}
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
