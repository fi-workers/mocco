import DocContent from '@frontend/components/doc-content';
import { ChangelogTagList, formatChangelogDate } from '@frontend/components/feedback/changelog-meta';
import FeedbackSiteLayout, {
  boardPath,
  changelogEntryPath,
  changelogPath,
  postPath,
} from '@frontend/components/feedback/feedback-site-layout';
import { FEEDBACK_REVALIDATE_SECONDS, loadChangelogEntryPage } from '@frontend/lib/feedback-site';
import { helpArticleCard } from '@frontend/lib/og-card';
import { breadcrumbLd } from '@frontend/lib/seo';

import type { DocBlock } from '@frontend/lib/doc-ast';
import type { FeedbackChangelogEntryPage } from '@frontend/lib/feedback-site';
import type { GetStaticPaths, GetStaticProps } from 'next';

interface Props {
  page: FeedbackChangelogEntryPage;
  blocks: DocBlock[];
  description: string;
  card: string | null;
}

// One published changelog entry (#176), at /feedback/<board>/changelog/<slug>: its text and the
// board's posts it shipped. A draft or scheduled entry has no page (404) until it is published.
export const getStaticPaths: GetStaticPaths = () => ({ paths: [], fallback: 'blocking' });

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => {
  const site = typeof params?.site === 'string' ? params.site : '';
  const board = typeof params?.board === 'string' ? params.board : '';
  const entry = typeof params?.entry === 'string' ? params.entry : '';
  const loaded = await loadChangelogEntryPage(site, board, entry);
  if (loaded === undefined) {
    return { notFound: true, revalidate: FEEDBACK_REVALIDATE_SECONDS };
  }
  const { page, blocks, description } = loaded;
  const card = helpArticleCard({
    siteName: page.site.name,
    eyebrow: `${page.board.name} changelog`,
    title: page.entry.title,
    description,
  });
  return { props: { page, blocks, description, card }, revalidate: FEEDBACK_REVALIDATE_SECONDS };
};

export default function FeedbackChangelogEntryPage({ page, blocks, description, card }: Props) {
  const { site, board, entry } = page;
  const path = changelogEntryPath(board.slug, entry.slug);
  return (
    <FeedbackSiteLayout
      site={site}
      board={board}
      current="changelog"
      title={entry.title}
      seo={{
        path,
        description,
        type: 'article',
        card,
        jsonLd: origin => [
          breadcrumbLd(origin, [
            { name: site.name, path: '/' },
            { name: board.name, path: boardPath(board.slug) },
            { name: 'Changelog', path: changelogPath(board.slug) },
            { name: entry.title, path },
          ]),
        ],
      }}>
      <article className="flex flex-col gap-4">
        <a href={changelogPath(board.slug)} className="text-sm text-muted-foreground hover:underline">
          ← Changelog
        </a>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <time dateTime={entry.publishedAt}>{formatChangelogDate(entry.publishedAt)}</time>
          <ChangelogTagList tags={entry.tags} />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{entry.title}</h1>
        <DocContent blocks={blocks} />
        {entry.posts.length === 0 ? null : (
          <section aria-labelledby="shipped" className="flex flex-col gap-2 border-t border-border pt-4">
            <h2 id="shipped" className="text-sm font-medium">
              Ideas this shipped
            </h2>
            <ul className="flex flex-col gap-1 text-sm">
              {entry.posts.map(post => (
                <li key={post.id}>
                  <a href={postPath(board.slug, post.number)} className="underline-offset-2 hover:underline">
                    #{post.number} {post.title}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>
    </FeedbackSiteLayout>
  );
}
