import FeedbackSiteLayout, { boardPath } from '@frontend/components/feedback/feedback-site-layout';
import NewPostForm from '@frontend/components/feedback/new-post-form';
import PostList from '@frontend/components/feedback/post-list';
import { FEEDBACK_REVALIDATE_SECONDS, loadBoardPage } from '@frontend/lib/feedback-site';
import { feedbackBoardCard } from '@frontend/lib/og-card';
import { breadcrumbLd } from '@frontend/lib/seo';

import type { FeedbackBoardPage } from '@frontend/lib/feedback-site';
import type { GetStaticPaths, GetStaticProps } from 'next';

interface Props {
  page: FeedbackBoardPage;
  card: string | null;
}

// A public feedback board (#175) on its project's help center site, at /feedback/<board>: the
// most voted posts, then posting an idea. Statically generated on first request and refreshed
// in the background (ISR, ADR 0015), so a crawler reads it without JavaScript; filters and later
// pages come from the browser.
export const getStaticPaths: GetStaticPaths = () => ({ paths: [], fallback: 'blocking' });

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => {
  const site = typeof params?.site === 'string' ? params.site : '';
  const board = typeof params?.board === 'string' ? params.board : '';
  const page = await loadBoardPage(site, board);
  if (page === undefined) {
    return { notFound: true, revalidate: FEEDBACK_REVALIDATE_SECONDS };
  }
  const card = feedbackBoardCard({ siteName: page.site.name, boardName: page.board.name });
  return { props: { page, card }, revalidate: FEEDBACK_REVALIDATE_SECONDS };
};

export default function FeedbackBoardPage({ page, card }: Props) {
  const path = boardPath(page.board.slug);
  return (
    <FeedbackSiteLayout
      site={page.site}
      board={page.board}
      title={page.board.name}
      seo={{
        path,
        description: `Ideas and requests for ${page.site.name}: vote on what you want next, or post your own.`,
        card,
        jsonLd: origin => [
          breadcrumbLd(origin, [
            { name: page.site.name, path: '/' },
            { name: page.board.name, path },
          ]),
        ],
      }}>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{page.board.name}</h1>
        <p className="text-muted-foreground">Vote on the ideas you want most, or post your own.</p>
      </div>
      <NewPostForm site={page.site.slug} board={page.board} />
      <PostList site={page.site.slug} board={page.board} initial={{ posts: page.posts, nextOffset: page.nextOffset }} />
    </FeedbackSiteLayout>
  );
}
