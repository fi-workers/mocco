import DocContent from '@frontend/components/doc-content';
import { ChangelogTagList, formatChangelogDate } from '@frontend/components/feedback/changelog-meta';
import FeedbackSiteLayout, {
  boardPath,
  changelogEntryPath,
  changelogPath,
  postPath,
} from '@frontend/components/feedback/feedback-site-layout';
import { FEEDBACK_REVALIDATE_SECONDS, loadChangelogPage } from '@frontend/lib/feedback-site';
import { feedbackBoardCard } from '@frontend/lib/og-card';
import { breadcrumbLd } from '@frontend/lib/seo';

import type { DocBlock } from '@frontend/lib/doc-ast';
import type { FeedbackChangelogPage } from '@frontend/lib/feedback-site';
import type { GetStaticPaths, GetStaticProps } from 'next';

interface Props {
  page: FeedbackChangelogPage;
  bodies: Record<string, DocBlock[]>;
  card: string | null;
}

// A public board's changelog (#176), at /feedback/<board>/changelog: published entries, newest
// first, each with what it shipped. Statically generated on first request (ISR, ADR 0015), so
// crawlers read it without JavaScript; feed readers follow changelog.rss.
export const getStaticPaths: GetStaticPaths = () => ({ paths: [], fallback: 'blocking' });

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => {
  const site = typeof params?.site === 'string' ? params.site : '';
  const board = typeof params?.board === 'string' ? params.board : '';
  const loaded = await loadChangelogPage(site, board);
  if (loaded === undefined) {
    return { notFound: true, revalidate: FEEDBACK_REVALIDATE_SECONDS };
  }
  const { page, bodies } = loaded;
  const card = feedbackBoardCard({ siteName: page.site.name, boardName: `${page.board.name} changelog` });
  return { props: { page, bodies, card }, revalidate: FEEDBACK_REVALIDATE_SECONDS };
};

export default function FeedbackChangelogPage({ page, bodies, card }: Props) {
  const { site, board, entries } = page;
  const path = changelogPath(board.slug);
  return (
    <FeedbackSiteLayout
      site={site}
      board={board}
      current="changelog"
      title={`${board.name} changelog`}
      seo={{
        path,
        description: `What's new in ${board.name}, from ${site.name}.`,
        card,
        jsonLd: origin => [
          breadcrumbLd(origin, [
            { name: site.name, path: '/' },
            { name: board.name, path: boardPath(board.slug) },
            { name: 'Changelog', path },
          ]),
        ],
      }}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Changelog</h1>
          <p className="text-muted-foreground">What&apos;s new in {board.name}.</p>
        </div>
        <a href={`${path}.rss`} className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          RSS feed
        </a>
      </div>
      {entries.length === 0 ? <p className="text-muted-foreground">Nothing has been announced yet.</p> : null}
      <ol className="flex flex-col gap-10">
        {entries.map(entry => (
          <li key={entry.id} className="flex flex-col gap-3 border-t border-border pt-6">
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <time dateTime={entry.publishedAt}>{formatChangelogDate(entry.publishedAt)}</time>
              <ChangelogTagList tags={entry.tags} />
            </div>
            <h2 className="text-xl font-semibold tracking-tight">
              <a href={changelogEntryPath(board.slug, entry.slug)} className="underline-offset-2 hover:underline">
                {entry.title}
              </a>
            </h2>
            <DocContent blocks={bodies[entry.id] ?? []} />
            {entry.posts.length === 0 ? null : (
              <ul className="flex flex-col gap-1 text-sm">
                {entry.posts.map(post => (
                  <li key={post.id}>
                    <a href={postPath(board.slug, post.number)} className="underline-offset-2 hover:underline">
                      #{post.number} {post.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </FeedbackSiteLayout>
  );
}
