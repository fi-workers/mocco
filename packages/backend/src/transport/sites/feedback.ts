// The data of the public feedback board pages (#175, ADR 0015): a project's public boards, served
// on its help center's site at /feedback/<board> (and its roadmap, posts and changelog, #176),
// plus what the site's sitemap lists of them. The pages' getStaticProps call these; nothing here needs a session.
// Every post and comment goes through the same @mocco/common/feedback-v1 schemas the /v1 routes
// answer with, so no field outside the public projection (a team member's id, an internal note,
// an end user's id) can reach a page.
import {
  feedbackV1BoardSchema,
  feedbackV1ChangelogEntrySchema,
  feedbackV1ChangelogListSchema,
  feedbackV1CommentListSchema,
  feedbackV1PostListSchema,
  feedbackV1PostSchema,
  feedbackV1RoadmapSchema,
  FeedbackPublicSorts,
} from '@mocco/common/feedback-v1';
import { z } from 'zod';

import { NotFoundError } from '@backend/domain/errors';
import { getFeedbackDomain } from '@backend/domain/feedback/instance';
import { getHelpDomain } from '@backend/domain/helpcenter/instance';
import { helpSiteOrigin } from '@backend/domain/helpcenter/site-url';
import { getEnv } from '@backend/infra/config/env';
import { wireChangelogEntry, wireComment, wirePost } from '@backend/transport/ext/v1/feedback';

import type { PublicBoardService } from '@backend/domain/feedback/PublicBoardService';
import type { HelpPublicReadService } from '@backend/domain/helpcenter/HelpPublicReadService';
import type { RoadmapColumn } from '@mocco/common/feedback';
import type { FeedbackV1ChangelogEntry, FeedbackV1Post } from '@mocco/common/feedback-v1';

/** How many posts a board page lists before "Load more", and how many comments a post page shows. */
export const FEEDBACK_PAGE_SIZE = 50;

const siteSchema = z.object({ slug: z.string(), name: z.string(), origin: z.string().nullable() });
const commentsSchema = feedbackV1CommentListSchema;

export type FeedbackPageSite = z.infer<typeof siteSchema>;
export type FeedbackPageBoard = z.infer<typeof feedbackV1BoardSchema>['board'];
export type FeedbackPageComment = z.infer<typeof commentsSchema>['comments'][number];

export interface FeedbackBoardPage {
  site: FeedbackPageSite;
  board: FeedbackPageBoard;
  /** The most voted posts, merged duplicates left out. */
  posts: FeedbackV1Post[];
  nextOffset: number | null;
}

export interface FeedbackPostPage {
  site: FeedbackPageSite;
  board: FeedbackPageBoard;
  post: FeedbackV1Post;
  /** The first public comments, oldest first; never an internal note. */
  comments: FeedbackPageComment[];
  hasMoreComments: boolean;
  /** The published changelog entries that announce the post, newest first. */
  changelog: { slug: string; title: string; publishedAt: string }[];
}

/** A board's changelog: published entries, newest first. */
export interface FeedbackChangelogPage {
  site: FeedbackPageSite;
  board: FeedbackPageBoard;
  entries: FeedbackV1ChangelogEntry[];
  nextOffset: number | null;
}

/** One published changelog entry. */
export interface FeedbackChangelogEntryPage {
  site: FeedbackPageSite;
  board: FeedbackPageBoard;
  entry: FeedbackV1ChangelogEntry;
}

/** A board's roadmap: the most voted posts of each of planned, in progress and shipped. */
export interface FeedbackRoadmapPage {
  site: FeedbackPageSite;
  board: FeedbackPageBoard;
  columns: Record<RoadmapColumn, FeedbackV1Post[]>;
}

/** A post page's answer: the page, a merged duplicate's target number, or nothing (404). */
export type FeedbackPostPageResult =
  { kind: 'page'; page: FeedbackPostPage } | { kind: 'merged'; intoNumber: number } | { kind: 'missing' };

export interface FeedbackPagesDeps {
  sites: Pick<HelpPublicReadService, 'projectOf'>;
  boards: Pick<
    PublicBoardService,
    | 'board'
    | 'posts'
    | 'postOnBoard'
    | 'comments'
    | 'roadmap'
    | 'sitemap'
    | 'changelog'
    | 'changelogEntry'
    | 'changelogForPost'
  >;
  /** Where a site is served (its custom domain, else its subdomain), or null when sites aren't served. */
  originOf: (site: string) => string | null;
}

/** A missing (or private) board, post or category reads as no page. */
const isMissing = (error: unknown) => error instanceof NotFoundError;

export function createFeedbackPages(deps: FeedbackPagesDeps) {
  const frame = async (site: string, boardSlug: string) => {
    const project = await deps.sites.projectOf(site);
    if (project === undefined) {
      return undefined;
    }
    const scope = { workspaceId: project.workspaceId, projectId: project.projectId };
    const { board } = feedbackV1BoardSchema.parse({ board: await deps.boards.board(scope, boardSlug) });
    return {
      scope,
      site: siteSchema.parse({ slug: site, name: project.name, origin: deps.originOf(site) }),
      board,
    };
  };

  return {
    /** A board's page, or undefined for no such site or public board. */
    async boardPage(site: string, boardSlug: string): Promise<FeedbackBoardPage | undefined> {
      try {
        const found = await frame(site, boardSlug);
        if (found === undefined) {
          return undefined;
        }
        const page = await deps.boards.posts(found.scope, boardSlug, {
          sort: FeedbackPublicSorts.top,
          limit: FEEDBACK_PAGE_SIZE,
          offset: 0,
        });
        const { posts, nextOffset } = feedbackV1PostListSchema.parse({
          posts: page.items.map(post => wirePost(post)),
          nextOffset: page.nextOffset,
        });
        return { site: found.site, board: found.board, posts, nextOffset };
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
    },

    /** A post's page by its number on the board. */
    async postPage(site: string, boardSlug: string, number: number): Promise<FeedbackPostPageResult> {
      try {
        const found = await frame(site, boardSlug);
        if (found === undefined) {
          return { kind: 'missing' };
        }
        const { post, mergedIntoNumber } = await deps.boards.postOnBoard(found.scope, boardSlug, number);
        if (mergedIntoNumber !== null) {
          return { kind: 'merged', intoNumber: mergedIntoNumber };
        }
        const comments = await deps.boards.comments(found.scope, post.id, { limit: FEEDBACK_PAGE_SIZE, offset: 0 });
        const parsed = commentsSchema.parse({
          comments: comments.items.map(comment => wireComment(comment)),
          nextOffset: comments.nextOffset,
        });
        const changelog = await deps.boards.changelogForPost(found.scope, post.id);
        return {
          kind: 'page',
          page: {
            site: found.site,
            board: found.board,
            post: feedbackV1PostSchema.parse(wirePost(post)),
            comments: parsed.comments,
            hasMoreComments: parsed.nextOffset !== null,
            changelog: changelog.map(entry => ({
              slug: entry.slug,
              title: entry.title,
              publishedAt: entry.publishedAt.toISOString(),
            })),
          },
        };
      } catch (error) {
        if (isMissing(error)) {
          return { kind: 'missing' };
        }
        throw error;
      }
    },

    /** A board's roadmap page: the most voted posts of each roadmap column, or undefined (404). */
    async roadmapPage(site: string, boardSlug: string): Promise<FeedbackRoadmapPage | undefined> {
      try {
        const found = await frame(site, boardSlug);
        if (found === undefined) {
          return undefined;
        }
        const roadmap = await deps.boards.roadmap(found.scope, boardSlug);
        const parsed = feedbackV1RoadmapSchema.parse({
          roadmap: Object.fromEntries(
            Object.entries(roadmap).map(([column, posts]) => [column, posts.map(post => wirePost(post))]),
          ),
        });
        return { site: found.site, board: found.board, columns: parsed.roadmap };
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
    },

    /** A board's changelog page: the newest published entries, or undefined (404). */
    async changelogPage(site: string, boardSlug: string): Promise<FeedbackChangelogPage | undefined> {
      try {
        const found = await frame(site, boardSlug);
        if (found === undefined) {
          return undefined;
        }
        const page = await deps.boards.changelog(found.scope, boardSlug, { limit: FEEDBACK_PAGE_SIZE, offset: 0 });
        const parsed = feedbackV1ChangelogListSchema.parse({
          entries: page.items.map(entry => wireChangelogEntry(entry)),
          nextOffset: page.nextOffset,
        });
        return { site: found.site, board: found.board, entries: parsed.entries, nextOffset: parsed.nextOffset };
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
    },

    /** One published entry's page by its slug, or undefined (404). */
    async changelogEntryPage(
      site: string,
      boardSlug: string,
      entrySlug: string,
    ): Promise<FeedbackChangelogEntryPage | undefined> {
      try {
        const found = await frame(site, boardSlug);
        if (found === undefined) {
          return undefined;
        }
        const entry = await deps.boards.changelogEntry(found.scope, boardSlug, entrySlug);
        return {
          site: found.site,
          board: found.board,
          entry: feedbackV1ChangelogEntrySchema.parse(wireChangelogEntry(entry)),
        };
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
    },

    /** The board pages a site's sitemap lists: each public board, its roadmap, its live posts and its changelog. */
    async sitemapPages(site: string): Promise<{ path: string; lastModified: Date }[]> {
      const project = await deps.sites.projectOf(site);
      if (project === undefined) {
        return [];
      }
      const boards = await deps.boards.sitemap({ workspaceId: project.workspaceId, projectId: project.projectId });
      return boards.flatMap(board => [
        { path: `/feedback/${board.slug}`, lastModified: board.updatedAt },
        { path: `/feedback/${board.slug}/roadmap`, lastModified: board.updatedAt },
        ...board.posts.map(post => ({
          path: `/feedback/${board.slug}/${String(post.number)}`,
          lastModified: post.updatedAt,
        })),
        // The changelog page only once there is something on it; it changes with its newest entry.
        ...(board.changelog[0] === undefined
          ? []
          : [{ path: `/feedback/${board.slug}/changelog`, lastModified: board.changelog[0].updatedAt }]),
        ...board.changelog.map(entry => ({
          path: `/feedback/${board.slug}/changelog/${entry.slug}`,
          lastModified: entry.updatedAt,
        })),
      ]);
    },
  };
}

const state: { pages?: ReturnType<typeof createFeedbackPages> } = {};

/** The pages' data over the production services. */
export function feedbackPages(): ReturnType<typeof createFeedbackPages> {
  state.pages ??= createFeedbackPages({
    sites: getHelpDomain().helpPublic,
    boards: getFeedbackDomain().feedbackPublic,
    originOf: site => helpSiteOrigin(site, getEnv()),
  });
  return state.pages;
}
