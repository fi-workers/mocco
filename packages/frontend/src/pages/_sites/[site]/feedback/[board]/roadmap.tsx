import { RoadmapColumns } from '@mocco/common/feedback';
import { useRouter } from 'next/router';

import FeedbackSiteLayout, {
  boardPath,
  postPath,
  roadmapPath,
} from '@frontend/components/feedback/feedback-site-layout';
import { feedbackStatusLabels } from '@frontend/lib/feedback-client';
import { FEEDBACK_REVALIDATE_SECONDS, loadRoadmapPage } from '@frontend/lib/feedback-site';
import { feedbackBoardCard } from '@frontend/lib/og-card';
import { breadcrumbLd } from '@frontend/lib/seo';
import { cn } from '@frontend/lib/utils';

import type { FeedbackRoadmapPage } from '@frontend/lib/feedback-site';
import type { GetStaticPaths, GetStaticProps } from 'next';

interface Props {
  page: FeedbackRoadmapPage;
  card: string | null;
}

// A public board's roadmap (#175), at /feedback/<board>/roadmap: planned, in progress and shipped
// side by side, the most voted posts of each first. Statically generated on first request (ISR,
// ADR 0015), so a crawler reads every column without JavaScript. The category filter lives in the
// address (`?category=<slug>`) and narrows the columns already on the page.
export const getStaticPaths: GetStaticPaths = () => ({ paths: [], fallback: 'blocking' });

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => {
  const site = typeof params?.site === 'string' ? params.site : '';
  const board = typeof params?.board === 'string' ? params.board : '';
  const page = await loadRoadmapPage(site, board);
  if (page === undefined) {
    return { notFound: true, revalidate: FEEDBACK_REVALIDATE_SECONDS };
  }
  const card = feedbackBoardCard({ siteName: page.site.name, boardName: `${page.board.name} roadmap` });
  return { props: { page, card }, revalidate: FEEDBACK_REVALIDATE_SECONDS };
};

export default function FeedbackRoadmapPage({ page, card }: Props) {
  const router = useRouter();
  const { site, board } = page;
  const path = roadmapPath(board.slug);
  const asked = typeof router.query.category === 'string' ? router.query.category : undefined;
  const category = board.categories.find(entry => entry.slug === asked);

  const chip = (label: string, slug: string | undefined) => {
    const href = slug === undefined ? path : `${path}?${new URLSearchParams({ category: slug }).toString()}`;
    const isActive = category?.slug === slug;
    return (
      <a
        key={label}
        href={href}
        aria-current={isActive ? 'true' : undefined}
        onClick={event => {
          event.preventDefault();
          // eslint-disable-next-line no-void -- a click handler can't await a shallow route change
          void router.replace(href, undefined, { shallow: true, scroll: false });
        }}
        className={cn(
          'rounded-full border border-border px-3 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground',
          isActive && 'border-foreground bg-foreground text-background hover:bg-foreground hover:text-background',
        )}>
        {label}
      </a>
    );
  };

  return (
    <FeedbackSiteLayout
      site={site}
      board={board}
      current="roadmap"
      title={`${board.name} roadmap`}
      seo={{
        path,
        description: `What ${site.name} has planned, is building and has shipped, from the ideas on ${board.name}.`,
        card,
        jsonLd: origin => [
          breadcrumbLd(origin, [
            { name: site.name, path: '/' },
            { name: board.name, path: boardPath(board.slug) },
            { name: 'Roadmap', path },
          ]),
        ],
      }}>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Roadmap</h1>
        <p className="text-muted-foreground">What&apos;s planned, in progress and shipped from {board.name}.</p>
      </div>
      {board.categories.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {chip('Every category', undefined)}
          {board.categories.map(entry => chip(entry.name, entry.slug))}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        {RoadmapColumns.map(column => {
          const posts = page.columns[column].filter(post => category === undefined || post.categoryId === category.id);
          return (
            <section
              key={column}
              aria-labelledby={`column-${column}`}
              className="flex flex-col gap-3 rounded-xl bg-muted/50 p-3">
              <h2 id={`column-${column}`} className="flex items-center justify-between px-1 font-medium">
                {feedbackStatusLabels[column]}
                <span className="text-sm font-normal text-muted-foreground tabular-nums">{posts.length}</span>
              </h2>
              {posts.length === 0 ? <p className="px-1 text-sm text-muted-foreground">Nothing here yet.</p> : null}
              <ul className="flex flex-col gap-2">
                {posts.map(post => (
                  <li
                    key={post.id}
                    className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
                    <span className="flex w-10 shrink-0 flex-col items-center rounded-md border border-border py-0.5">
                      <span className="text-sm leading-tight font-semibold tabular-nums">{post.voteCount}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {post.voteCount === 1 ? 'vote' : 'votes'}
                      </span>
                    </span>
                    <a
                      href={postPath(board.slug, post.number)}
                      className="text-sm font-medium underline-offset-2 hover:underline">
                      {post.title}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </FeedbackSiteLayout>
  );
}
