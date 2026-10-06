// The data of the public feedback board pages (#175, ADR 0015): a project's public boards, served
// on its help center's site at /feedback/<board>. The pages' getStaticProps call these; nothing
// here needs a session. Every post and comment goes through the same @mocco/common/feedback-v1
// schemas the /v1 routes answer with, so no field outside the public projection (a team
// member's id, an internal note, an end user's id) can reach a page.
import {
  feedbackV1BoardSchema,
  feedbackV1CommentListSchema,
  feedbackV1PostListSchema,
  feedbackV1PostSchema,
  FeedbackPublicSorts,
} from '@mocco/common/feedback-v1';
import { z } from 'zod';

import { NotFoundError } from '@backend/domain/errors';
import { getFeedbackDomain } from '@backend/domain/feedback/instance';
import { getHelpDomain } from '@backend/domain/helpcenter/instance';
import { helpSiteOrigin } from '@backend/domain/helpcenter/site-url';
import { getEnv } from '@backend/infra/config/env';
import { wireComment, wirePost } from '@backend/transport/ext/v1/feedback';

import type { PublicBoardService } from '@backend/domain/feedback/PublicBoardService';
import type { HelpPublicReadService } from '@backend/domain/helpcenter/HelpPublicReadService';
import type { FeedbackV1Post } from '@mocco/common/feedback-v1';

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
}

/** A post page's answer: the page, a merged duplicate's target number, or nothing (404). */
export type FeedbackPostPageResult =
  { kind: 'page'; page: FeedbackPostPage } | { kind: 'merged'; intoNumber: number } | { kind: 'missing' };

export interface FeedbackPagesDeps {
  sites: Pick<HelpPublicReadService, 'projectOf'>;
  boards: Pick<PublicBoardService, 'board' | 'posts' | 'postOnBoard' | 'comments'>;
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
        return {
          kind: 'page',
          page: {
            site: found.site,
            board: found.board,
            post: feedbackV1PostSchema.parse(wirePost(post)),
            comments: parsed.comments,
            hasMoreComments: parsed.nextOffset !== null,
          },
        };
      } catch (error) {
        if (isMissing(error)) {
          return { kind: 'missing' };
        }
        throw error;
      }
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
