// /v1/feedback (#174): a project's public feedback boards for its app, widget or board page.
// Reads take a key with feedback:read. Votes and comments take a key with feedback:write
// plus the end user's token: an HS256 JWT the app's server signs with the project's identity
// secret, sent as `Authorization: Bearer …` (the key then rides in `X-Mocco-Key`). A token
// on a read adds the viewer's own vote and marks their comments. Posting, following a post
// and the similar-posts search work the same way; voting by email and the mail links are in
// feedback-links.ts. Every answer is parsed
// through its @mocco/common/feedback-v1 schema, so nothing outside the public projection
// reaches the wire.
import { createHash } from 'node:crypto';

import { ApiScopes } from '@mocco/common/apikey';
import {
  feedbackV1BoardSchema,
  feedbackV1CommentInputSchema,
  feedbackV1CommentListSchema,
  feedbackV1CommentResultSchema,
  feedbackV1PageQuerySchema,
  feedbackV1PostDetailSchema,
  feedbackV1PostListQuerySchema,
  feedbackV1PostCreateInputSchema,
  feedbackV1PostListSchema,
  feedbackV1PostResultSchema,
  feedbackV1RoadmapSchema,
  feedbackV1SimilarQuerySchema,
  feedbackV1SimilarSchema,
  feedbackV1SlugSchema,
  feedbackV1SubscriptionResultSchema,
  feedbackV1VoteInputSchema,
  feedbackV1VoteResultSchema,
} from '@mocco/common/feedback-v1';
import { Hono } from 'hono';
import { z } from 'zod';

import { EndUserTokenRefusals, EndUserTokenRejectedError } from '@backend/domain/enduser/errors';
import { BadRequestError, NotFoundError } from '@backend/domain/errors';
import { EMAIL_END_USER_PREFIX } from '@backend/domain/feedback/EmailVoteService';
import { FeedbackPostMergedError } from '@backend/domain/feedback/errors';
import { createFeedbackLinkRoutes } from '@backend/transport/ext/v1/feedback-links';
import { bearerOf, ipBucketOf, isApiKeyToken, limit, requireKey } from '@backend/transport/ext/v1/middleware';
import { parseJson, problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { EndUserTokenService } from '@backend/domain/enduser/EndUserTokenService';
import type { EmailVoteService } from '@backend/domain/feedback/EmailVoteService';
import type { PublicBoardService, PublicComment, PublicPost } from '@backend/domain/feedback/PublicBoardService';
import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';
import type { RoadmapColumn } from '@mocco/common/feedback';
import type { Context } from 'hono';

export interface FeedbackServingDeps {
  boards: Pick<
    PublicBoardService,
    | 'board'
    | 'posts'
    | 'roadmap'
    | 'post'
    | 'comments'
    | 'vote'
    | 'unvote'
    | 'comment'
    | 'createPost'
    | 'similar'
    | 'setSubscribed'
  >;
  endUsers: Pick<EndUserTokenService, 'verify'>;
  /** Voting by email and the signed mail links; undefined without AUTH_SECRET (those routes 503). */
  emailVotes?: Pick<EmailVoteService, 'canSendMail' | 'start' | 'confirm' | 'describeUnsubscribe' | 'unsubscribe'>;
}

/** End users' write limits, on top of the key's own (feedback design §8). */
export const FeedbackRateLimits = {
  /** Votes and unvotes per end user. */
  votes: { limit: 30, windowSeconds: 60 * 60 },
  /** Comments per end user. */
  comments: { limit: 20, windowSeconds: 60 * 60 },
  /** New posts per end user. */
  posts: { limit: 5, windowSeconds: 60 * 60 },
  /** Follows and unfollows per end user. */
  subscriptions: { limit: 30, windowSeconds: 60 * 60 },
  /** Similar-posts searches per client address (typed as a title is written). */
  similar: { limit: 60, windowSeconds: 60 },
  /** Every write from one client address, whoever the end user. */
  writesPerAddress: { limit: 120, windowSeconds: 60 * 60 },
} as const;

const refusalTitles: Record<EndUserTokenRejectedError['refusal'], string> = {
  [EndUserTokenRefusals.invalid]: "The end-user token isn't signed with this project's identity secret",
  [EndUserTokenRefusals.expired]: 'The end-user token has expired',
  [EndUserTokenRefusals.tooLong]: 'The end-user token must expire within an hour',
  [EndUserTokenRefusals.noSecret]: 'This project has no identity secret to verify end-user tokens with',
};

/** The domain errors a request can cause, as problem responses. */
function problemFor(error: unknown): Response {
  if (error instanceof EndUserTokenRejectedError) {
    return problemResponse(problemOf(401, ProblemCodes.invalidEndUserToken, refusalTitles[error.refusal]), {
      'WWW-Authenticate': 'Bearer error="invalid_token"',
    });
  }
  if (error instanceof FeedbackPostMergedError) {
    return problemResponse(
      problemOf(
        409,
        ProblemCodes.conflict,
        'This post was merged into another',
        `mergedIntoPostId: ${error.intoPostId}`,
      ),
    );
  }
  if (error instanceof NotFoundError) {
    return problemResponse(problemOf(404, ProblemCodes.notFound, 'Not found'));
  }
  if (error instanceof BadRequestError) {
    return problemResponse(problemOf(400, ProblemCodes.badRequest, 'Invalid request', error.message));
  }
  throw error;
}

const answer = async (work: () => Promise<Response>): Promise<Response> => {
  try {
    return await work();
  } catch (error) {
    return problemFor(error);
  }
};

const iso = (at: Date) => at.toISOString();

const wirePost = (post: PublicPost) => ({
  ...post,
  createdAt: iso(post.createdAt),
  shippedAt: post.shippedAt === null ? null : iso(post.shippedAt),
});

const wireRoadmap = (roadmap: Record<RoadmapColumn, PublicPost[]>) =>
  Object.fromEntries(
    Object.entries(roadmap).map(([column, posts]) => [column, posts.map(post => wirePost(post))]),
  ) as Record<RoadmapColumn, ReturnType<typeof wirePost>[]>;

const wireComment = (comment: PublicComment) => ({ ...comment, createdAt: iso(comment.createdAt) });

/** `body` narrowed by `schema`: a field the schema doesn't name is dropped. */
const send = <S extends z.ZodType>(c: Context, schema: S, body: z.input<S>, status: 200 | 201 | 202 = 200) =>
  c.json(schema.parse(body), status);

/** A path that names no post. */
class PostPathNotFoundError extends NotFoundError {}

/** An optional JSON body: `{}` when empty, null (refused by any object schema) when not JSON. */
async function optionalJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  // eslint-disable-next-line sonarjs/null-dereference -- c.req.text() resolves to a string, never null
  if (text.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const badQuery = (detail: string) =>
  problemResponse(problemOf(400, ProblemCodes.badRequest, 'Invalid request', detail));

/** A bounded, hashed bucket for one end user of one project. */
const endUserBucket = (name: string, projectId: string, endUserId: string) => {
  const hash = createHash('sha256').update(projectId).update('\n').update(endUserId).digest('hex');
  // eslint-disable-next-line sonarjs/null-dereference -- digest('hex') returns a string, never null
  return `feedback:${name}:${hash.slice(0, 32)}`;
};

export function createFeedbackRoutes(deps: V1Deps, feedback: FeedbackServingDeps): Hono<V1Env> {
  const app = new Hono<V1Env>();
  const read = requireKey(deps, { scope: ApiScopes.feedbackRead });
  const write = requireKey(deps, { scope: ApiScopes.feedbackWrite });

  /** The end user the request's token names, undefined without one; a bad token throws. */
  const viewerOf = async (c: Context<V1Env>): Promise<string | undefined> => {
    const token = bearerOf(c);
    if (token === undefined || token === '' || isApiKeyToken(token)) {
      return undefined;
    }
    const { workspaceId, projectId } = c.var.principal;
    const { endUserId } = await feedback.endUsers.verify({ workspaceId, projectId }, token);

    if (endUserId.startsWith(EMAIL_END_USER_PREFIX)) {
      // Email voters' ids are Mocco's own: a signed token can't claim one.
      throw new EndUserTokenRejectedError(EndUserTokenRefusals.invalid);
    }
    return endUserId;
  };

  /** The signed-in end user for a write, after the write limits; else the refusal. */
  const writerOf = async (
    c: Context<V1Env>,
    limitName: 'votes' | 'comments' | 'posts' | 'subscriptions',
  ): Promise<{ endUserId: string; refused?: undefined } | { endUserId?: undefined; refused: Response }> => {
    const endUserId = await viewerOf(c);
    if (endUserId === undefined) {
      return {
        refused: problemResponse(
          problemOf(401, ProblemCodes.missingEndUserToken, "An end-user token from the app's server is required"),
          { 'WWW-Authenticate': 'Bearer' },
        ),
      };
    }
    const byAddress = await limit(deps, `feedback:writes:ip:${ipBucketOf(c)}`, FeedbackRateLimits.writesPerAddress);
    if (byAddress.refused !== undefined) {
      return { refused: byAddress.refused };
    }
    const byUser = await limit(
      deps,
      endUserBucket(limitName, c.var.principal.projectId, endUserId),
      FeedbackRateLimits[limitName],
    );
    if (byUser.refused !== undefined) {
      return { refused: byUser.refused };
    }
    return { endUserId };
  };

  const scopeOf = (c: Context<V1Env>) => ({
    workspaceId: c.var.principal.workspaceId,
    projectId: c.var.principal.projectId,
  });

  const slugOf = (c: Context<V1Env>) => feedbackV1SlugSchema.safeParse(c.req.param('slug'));
  /** The path's post id; anything but a uuid is no post (404). */
  const postIdOf = (c: Context<V1Env>) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) {
      throw new PostPathNotFoundError();
    }
    return id.data;
  };

  app.get('/boards/:slug', read, async c => {
    const slug = slugOf(c);
    if (!slug.success) {
      return problemResponse(problemOf(404, ProblemCodes.notFound, 'Not found'));
    }
    return await answer(async () =>
      send(c, feedbackV1BoardSchema, { board: await feedback.boards.board(scopeOf(c), slug.data) }),
    );
  });

  app.get('/boards/:slug/posts', read, async c => {
    const slug = slugOf(c);
    if (!slug.success) {
      return problemResponse(problemOf(404, ProblemCodes.notFound, 'Not found'));
    }
    const query = feedbackV1PostListQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return badQuery('status, category, sort (top or new), limit (1–100) or offset is invalid');
    }
    return await answer(async () => {
      const page = await feedback.boards.posts(scopeOf(c), slug.data, query.data);
      return send(c, feedbackV1PostListSchema, {
        posts: page.items.map(post => wirePost(post)),
        nextOffset: page.nextOffset,
      });
    });
  });

  app.get('/boards/:slug/roadmap', read, async c => {
    const slug = slugOf(c);
    if (!slug.success) {
      return problemResponse(problemOf(404, ProblemCodes.notFound, 'Not found'));
    }
    return await answer(async () => {
      const roadmap = await feedback.boards.roadmap(scopeOf(c), slug.data);
      return send(c, feedbackV1RoadmapSchema, { roadmap: wireRoadmap(roadmap) });
    });
  });

  app.get(
    '/posts/:id',
    read,
    async c =>
      await answer(async () => {
        const detail = await feedback.boards.post(scopeOf(c), postIdOf(c), await viewerOf(c));
        return send(c, feedbackV1PostDetailSchema, { post: wirePost(detail.post), viewer: detail.viewer });
      }),
  );

  app.get('/posts/:id/comments', read, async c => {
    const page = feedbackV1PageQuerySchema.safeParse(c.req.query());
    if (!page.success) {
      return badQuery('limit (1–100) or offset is invalid');
    }
    return await answer(async () => {
      const comments = await feedback.boards.comments(scopeOf(c), postIdOf(c), page.data, await viewerOf(c));
      return send(c, feedbackV1CommentListSchema, {
        comments: comments.items.map(comment => wireComment(comment)),
        nextOffset: comments.nextOffset,
      });
    });
  });

  app.post(
    '/posts/:id/vote',
    write,
    async c =>
      await answer(async () => {
        const writer = await writerOf(c, 'votes');
        if (writer.refused !== undefined) {
          return writer.refused;
        }
        const input = feedbackV1VoteInputSchema.safeParse(await optionalJson(c));
        if (!input.success) {
          return badQuery('The body is optional; when sent, it is JSON and source is web or widget');
        }
        const result = await feedback.boards.vote(scopeOf(c), postIdOf(c), writer.endUserId, input.data.source);
        return send(c, feedbackV1VoteResultSchema, result);
      }),
  );

  app.delete(
    '/posts/:id/vote',
    write,
    async c =>
      await answer(async () => {
        const writer = await writerOf(c, 'votes');
        if (writer.refused !== undefined) {
          return writer.refused;
        }
        return send(
          c,
          feedbackV1VoteResultSchema,
          await feedback.boards.unvote(scopeOf(c), postIdOf(c), writer.endUserId),
        );
      }),
  );

  app.post(
    '/posts/:id/comments',
    write,
    async c =>
      await answer(async () => {
        const writer = await writerOf(c, 'comments');
        if (writer.refused !== undefined) {
          return writer.refused;
        }
        const body = await parseJson(c, feedbackV1CommentInputSchema);
        if (body.refused !== undefined) {
          return body.refused;
        }
        const comment = await feedback.boards.comment(scopeOf(c), postIdOf(c), writer.endUserId, body.data.body);
        return send(c, feedbackV1CommentResultSchema, { comment: wireComment(comment) }, 201);
      }),
  );

  app.get('/boards/:slug/similar', read, async c => {
    const slug = slugOf(c);
    if (!slug.success) {
      return problemResponse(problemOf(404, ProblemCodes.notFound, 'Not found'));
    }
    const query = feedbackV1SimilarQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return badQuery('q is required (1–200 characters); limit is 1–10');
    }
    const limited = await limit(deps, `feedback:similar:ip:${ipBucketOf(c)}`, FeedbackRateLimits.similar);
    if (limited.refused !== undefined) {
      return limited.refused;
    }
    return await answer(async () => {
      const posts = await feedback.boards.similar(scopeOf(c), slug.data, query.data.q, query.data.limit);
      return send(c, feedbackV1SimilarSchema, { posts: posts.map(post => wirePost(post)) });
    });
  });

  app.post('/boards/:slug/posts', write, async c => {
    const slug = slugOf(c);
    if (!slug.success) {
      return problemResponse(problemOf(404, ProblemCodes.notFound, 'Not found'));
    }
    return await answer(async () => {
      const writer = await writerOf(c, 'posts');
      if (writer.refused !== undefined) {
        return writer.refused;
      }
      const body = await parseJson(
        c,
        feedbackV1PostCreateInputSchema.extend({ source: feedbackV1VoteInputSchema.shape.source }),
      );
      if (body.refused !== undefined) {
        return body.refused;
      }
      const post = await feedback.boards.createPost(scopeOf(c), slug.data, writer.endUserId, body.data);
      return send(c, feedbackV1PostResultSchema, { post: wirePost(post) }, 201);
    });
  });

  const subscription = (isSubscribed: boolean) => async (c: Context<V1Env>) =>
    await answer(async () => {
      const writer = await writerOf(c, 'subscriptions');
      if (writer.refused !== undefined) {
        return writer.refused;
      }
      return send(
        c,
        feedbackV1SubscriptionResultSchema,
        await feedback.boards.setSubscribed(scopeOf(c), postIdOf(c), writer.endUserId, isSubscribed),
      );
    });
  app.post('/posts/:id/subscription', write, subscription(true));
  app.delete('/posts/:id/subscription', write, subscription(false));

  app.route('/', createFeedbackLinkRoutes(deps, { emailVotes: feedback.emailVotes, answer, send }));

  return app;
}
