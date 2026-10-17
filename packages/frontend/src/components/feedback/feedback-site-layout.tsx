// The frame of a public feedback board (pages/_sites/[site]/feedback/**, #175): the site's name
// (back to its help center), the board with its Ideas, Roadmap and Changelog, and the search and
// share metadata. Canonical and Open
// Graph URLs are absolute on the site's own origin (its custom domain when it has one, or the app's
// own origin for the site HELP_APP_HOST_SITE mounts there). Links are plain anchors: the pages are
// served on the site's host (or that app host), under /feedback/<board>.
import Head from 'next/head';

import SeoHead from '@frontend/components/seo-head';
import { cn } from '@frontend/lib/utils';

import type { FeedbackPageBoard, FeedbackPageSite } from '@mocco/backend/sites/feedback';
import type { ReactNode } from 'react';

export const boardPath = (board: string) => `/feedback/${board}`;
export const roadmapPath = (board: string) => `/feedback/${board}/roadmap`;
export const postPath = (board: string, number: number) => `/feedback/${board}/${String(number)}`;
export const changelogPath = (board: string) => `/feedback/${board}/changelog`;
export const changelogEntryPath = (board: string, entry: string) => `/feedback/${board}/changelog/${entry}`;

export default function FeedbackSiteLayout({
  site,
  board,
  title,
  current,
  seo,
  children,
}: {
  site: FeedbackPageSite;
  board: FeedbackPageBoard;
  title: string;
  /** Which of the board's pages this is, for the header's links. */
  current: 'board' | 'roadmap' | 'post' | 'changelog';
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
        {/* Feed readers find the board's changelog from any of its pages. */}
        <link
          key="changelog-rss"
          rel="alternate"
          type="application/rss+xml"
          title={`${board.name} changelog`}
          href={`${changelogPath(board.slug)}.rss`}
        />
      </Head>
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="flex h-14 items-center gap-3 border-b border-border px-4 md:px-6">
          {/* The site's help center home on its own host (the app's home on the app's host): not a page of this app's router. */}
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
          <nav aria-label="Board" className="ml-auto flex items-center gap-1 text-sm">
            {(
              [
                ['board', 'Ideas', boardPath(board.slug)],
                ['roadmap', 'Roadmap', roadmapPath(board.slug)],
                ['changelog', 'Changelog', changelogPath(board.slug)],
              ] as const
            ).map(([section, label, href]) => (
              <a
                key={section}
                href={href}
                aria-current={current === section ? 'page' : undefined}
                className={cn(
                  'rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground',
                  current === section && 'bg-muted font-medium text-foreground',
                )}>
                {label}
              </a>
            ))}
          </nav>
        </header>
        <main
          className={cn(
            'mx-auto flex w-full flex-1 flex-col gap-8 px-4 py-8 md:px-6 md:py-10',
            current === 'roadmap' ? 'max-w-6xl' : 'max-w-3xl',
          )}>
          {children}
        </main>
      </div>
    </>
  );
}
