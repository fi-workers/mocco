// Server-side data for the public feedback board pages (pages/_sites/[site]/feedback/**, #175):
// a project's public boards on its help center's site. Reads go through the backend's page
// loaders, which keep to the public projection; a post's Markdown becomes the render tree here.
// Only getStaticProps calls this; nothing here reaches the browser bundle.
import { feedbackPages } from '@mocco/backend/sites/feedback';

import { helpArticleBlocks } from '@frontend/lib/help-markdown';
import { markdownToBlocks } from '@frontend/lib/markdown-blocks';
import { excerptOf } from '@frontend/lib/seo';

import type { DocBlock } from '@frontend/lib/doc-ast';
import type {
  FeedbackBoardPage,
  FeedbackChangelogEntryPage,
  FeedbackChangelogPage,
  FeedbackPostPage,
  FeedbackRoadmapPage,
} from '@mocco/backend/sites/feedback';

export type {
  FeedbackBoardPage,
  FeedbackChangelogEntryPage,
  FeedbackChangelogPage,
  FeedbackPostPage,
  FeedbackRoadmapPage,
} from '@mocco/backend/sites/feedback';

/** Pages regenerate at most this often after a request (ISR); the browser fetches live counts. */
export const FEEDBACK_REVALIDATE_SECONDS = 60;

/** A post number as its URL carries it, or null. */
export function postNumberOf(param: unknown): number | null {
  if (typeof param !== 'string' || !/^[1-9]\d{0,9}$/u.test(param)) {
    return null;
  }
  return Number(param);
}

/**
 * An end user's Markdown: links and images show as their text, so a public board is no place to
 * plant links or tracking pixels. Raw HTML renders as text, as everywhere.
 */
export function postBodyBlocks(markdown: string): DocBlock[] {
  return markdownToBlocks(markdown, { link: () => null, image: () => null });
}

export async function loadBoardPage(site: string, board: string): Promise<FeedbackBoardPage | undefined> {
  return await feedbackPages().boardPage(site, board);
}

export async function loadRoadmapPage(site: string, board: string): Promise<FeedbackRoadmapPage | undefined> {
  return await feedbackPages().roadmapPage(site, board);
}

export async function loadPostPage(site: string, board: string, number: number) {
  const result = await feedbackPages().postPage(site, board, number);
  if (result.kind !== 'page') {
    return result;
  }
  const blocks = postBodyBlocks(result.page.post.body);
  return {
    kind: result.kind,
    page: result.page satisfies FeedbackPostPage,
    blocks,
    description: excerptOf(blocks) || result.page.post.title,
  };
}

/** A changelog entry is the team's text: links and https images render as in a help article. */
export const changelogBodyBlocks = (markdown: string): DocBlock[] => helpArticleBlocks(markdown);

/** A board's changelog with each entry's body as a render tree. */
export async function loadChangelogPage(site: string, board: string) {
  const page = await feedbackPages().changelogPage(site, board);
  if (page === undefined) {
    return undefined;
  }
  return {
    page: page satisfies FeedbackChangelogPage,
    bodies: Object.fromEntries(page.entries.map(entry => [entry.id, changelogBodyBlocks(entry.body)])),
  };
}

export async function loadChangelogEntryPage(site: string, board: string, entry: string) {
  const page = await feedbackPages().changelogEntryPage(site, board, entry);
  if (page === undefined) {
    return undefined;
  }
  const blocks = changelogBodyBlocks(page.entry.body);
  return {
    page: page satisfies FeedbackChangelogEntryPage,
    blocks,
    description: excerptOf(blocks) || page.entry.title,
  };
}
