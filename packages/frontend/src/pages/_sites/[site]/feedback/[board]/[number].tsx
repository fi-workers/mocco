import DocContent from '@frontend/components/doc-content';
import FeedbackSiteLayout, { boardPath, postPath } from '@frontend/components/feedback/feedback-site-layout';
import PostComments from '@frontend/components/feedback/post-comments';
import { StatusBadge } from '@frontend/components/feedback/post-list';
import VoteBox from '@frontend/components/feedback/vote-box';
import { FEEDBACK_REVALIDATE_SECONDS, loadPostPage, postNumberOf } from '@frontend/lib/feedback-site';
import { helpArticleCard } from '@frontend/lib/og-card';
import { breadcrumbLd, feedbackPostLd } from '@frontend/lib/seo';

import type { DocBlock } from '@frontend/lib/doc-ast';
import type { FeedbackPostPage } from '@frontend/lib/feedback-site';
import type { GetStaticPaths, GetStaticProps } from 'next';

interface Props {
  page: FeedbackPostPage;
  blocks: DocBlock[];
  description: string;
  card: string | null;
}

// One post of a public feedback board (#175), at /feedback/<board>/<number>: its status, votes,
// body and public comments. A merged duplicate redirects permanently to the post it was merged
// into. Statically generated on first request (ISR, ADR 0015); the live count and the viewer's
// own vote come from the browser.
export const getStaticPaths: GetStaticPaths = () => ({ paths: [], fallback: 'blocking' });

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => {
  const site = typeof params?.site === 'string' ? params.site : '';
  const board = typeof params?.board === 'string' ? params.board : '';
  const number = postNumberOf(params?.number);
  const result = number === null ? undefined : await loadPostPage(site, board, number);
  if (result === undefined || result.kind === 'missing') {
    return { notFound: true, revalidate: FEEDBACK_REVALIDATE_SECONDS };
  }
  if (result.kind === 'merged') {
    return {
      redirect: { destination: postPath(board, result.intoNumber), permanent: true },
      revalidate: FEEDBACK_REVALIDATE_SECONDS,
    };
  }
  const { page, blocks, description } = result;
  const card = helpArticleCard({
    siteName: page.site.name,
    eyebrow: page.board.name,
    title: page.post.title,
    description,
  });
  return { props: { page, blocks, description, card }, revalidate: FEEDBACK_REVALIDATE_SECONDS };
};

export default function FeedbackPostPage({ page, blocks, description, card }: Props) {
  const { site, board, post } = page;
  const path = postPath(board.slug, post.number);
  const category = board.categories.find(entry => entry.id === post.categoryId);
  return (
    <FeedbackSiteLayout
      site={site}
      board={board}
      title={post.title}
      seo={{
        path,
        description,
        type: 'article',
        card,
        jsonLd: origin => [
          breadcrumbLd(origin, [
            { name: site.name, path: '/' },
            { name: board.name, path: boardPath(board.slug) },
            { name: post.title, path },
          ]),
          feedbackPostLd(origin, {
            path,
            title: post.title,
            text: description,
            createdAt: post.createdAt,
            voteCount: post.voteCount,
            commentCount: post.commentCount,
          }),
        ],
      }}>
      <article className="flex flex-col gap-4">
        <a href={boardPath(board.slug)} className="text-sm text-muted-foreground hover:underline">
          ← {board.name}
        </a>
        <h1 className="text-3xl font-semibold tracking-tight">{post.title}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <StatusBadge status={post.status} />
          {category === undefined ? null : <span>{category.name}</span>}
          <span>#{post.number}</span>
        </div>
        <VoteBox site={site.slug} postId={post.id} initialCount={post.voteCount} />
        {blocks.length === 0 ? null : <DocContent blocks={blocks} />}
      </article>
      <PostComments site={site.slug} postId={post.id} initial={page.comments} hasMore={page.hasMoreComments} />
    </FeedbackSiteLayout>
  );
}
