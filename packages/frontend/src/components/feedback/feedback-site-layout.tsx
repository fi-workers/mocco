// The frame of a public feedback board (pages/_sites/[site]/feedback/**, #175): the site's name
// (back to its help center), the board, and the search and share metadata. Canonical and Open
// Graph URLs are absolute on the site's own origin (its custom domain when it has one). Links
// are plain anchors: the pages are served on the site's host, under /feedback/<board>.
import Head from 'next/head';

import SeoHead from '@frontend/components/seo-head';

import type { FeedbackPageBoard, FeedbackPageSite } from '@mocco/backend/sites/feedback';
import type { ReactNode } from 'react';

export const boardPath = (board: string) => `/feedback/${board}`;
export const postPath = (board: string, number: number) => `/feedback/${board}/${String(number)}`;

export default function FeedbackSiteLayout({
  site,
  board,
  title,
  seo,
  children,
}: {
  site: FeedbackPageSite;
  board: FeedbackPageBoard;
  title: string;
  seo: {
    path: string;
    description: string;
    type?: 'website' | 'article';
    /** The page's share card, an issued `/og/v1/...` path on the site's origin; none when null. */
    card: string | null;
    jsonLd?: (origin: string) => readonly Record<string, unknown>[];
  };
  children: ReactNode;
}) {
  const fullTitle = `${title} · ${site.name}`;
  return (
    <>
      {site.origin === null ? (
        <Head>
          <title key="title">{fullTitle}</title>
          <meta key="robots" name="robots" content="noindex, follow" />
        </Head>
      ) : (
        <SeoHead
          title={fullTitle}
          description={seo.description}
          url={`${site.origin}${seo.path}`}
          origin={site.origin}
          type={seo.type ?? 'website'}
          siteName={site.name}
          withImage={seo.card !== null}
          image={seo.card === null ? null : { path: seo.card, alt: fullTitle }}
          jsonLd={seo.jsonLd?.(site.origin) ?? []}
        />
      )}
      <Head>
        {/* An app hands its signed-in user's token over in the address; never pass it on. */}
        <meta key="referrer" name="referrer" content="no-referrer" />
      </Head>
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="flex h-14 items-center gap-3 border-b border-border px-4 md:px-6">
          {/* The site's help center home, on the site's own host: not a page of this app's router. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a rewritten host, see above */}
          <a href="/" className="shrink-0 font-semibold tracking-tight">
            {site.name}
          </a>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <a href={boardPath(board.slug)} className="truncate text-sm font-medium hover:underline">
            {board.name}
          </a>
        </header>
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-8 md:px-6 md:py-10">
          {children}
        </main>
      </div>
    </>
  );
}
