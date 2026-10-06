// Voting by email (#174): someone without a signed-in account votes with their address. The vote
// is written pending and a mail with a signed link goes to the address; opening the link counts
// every pending vote that address cast in the project in the last week. The same mail carries a
// signed one-click unsubscribe link (List-Unsubscribe), which any later feedback mail can reuse.
// Mail goes through the notifications email sender (EMAIL_DRIVER; `log` prints it instead).
import { FeedbackVoteStates } from '@mocco/common/feedback';

import {
  FeedbackLinkInvalidError,
  FeedbackMailUnavailableError,
  FeedbackPostMergedError,
  FeedbackPostNotFoundError,
} from '@backend/domain/feedback/errors';
import { renderIdentifyMail } from '@backend/domain/feedback/link-mail';
import { FeedbackLinkPurposes } from '@backend/domain/feedback/link-tokens';
import { FeedbackVoteRepo } from '@backend/domain/feedback/repos/vote.repo';
import { EmailResultKinds } from '@backend/domain/notification/senders/email';

import type { FeedbackLinkTokens } from '@backend/domain/feedback/link-tokens';
import type { PublicBoardService, PublicVoteSource } from '@backend/domain/feedback/PublicBoardService';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { VoteService } from '@backend/domain/feedback/VoteService';
import type { EmailSender } from '@backend/domain/notification/senders/email';
import type { Db } from '@backend/infra/db/types';

/** An email-only voter's end-user id: `email:` and the address, lowercased. Signed-in end users
 * can't take ids in this space (the /v1 transport refuses a token whose `sub` starts with it). */
export const EMAIL_END_USER_PREFIX = 'email:';
export const emailEndUserIdOf = (email: string): string =>
  // eslint-disable-next-line sonarjs/null-dereference -- email is a parsed string, never null
  `${EMAIL_END_USER_PREFIX}${email.trim().toLowerCase()}`;

/** Pending votes older than this aren't counted by a confirmation (feedback design §8). */
export const PENDING_VOTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface EmailVoteServiceDeps {
  db: Db;
  boards: Pick<PublicBoardService, 'vote' | 'postTitle' | 'setSubscribed'>;
  votes: Pick<VoteService, 'confirm'>;
  tokens: FeedbackLinkTokens;
  /** Undefined when this deployment sends no email: email votes are refused. */
  email: EmailSender | undefined;
  /** The app's origin, for the links in mail. */
  appOrigin: string;
  now?: () => Date;
}

const LINK_BASE = '/api/ext/v1/feedback';

export class EmailVoteService {
  constructor(private readonly deps: EmailVoteServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private claimsOfUnsubscribe(token: string) {
    const claims = this.deps.tokens.verify(FeedbackLinkPurposes.unsubscribe, token, this.now());
    if (claims?.postId === undefined) {
      throw new FeedbackLinkInvalidError();
    }
    return {
      scope: { workspaceId: claims.workspaceId, projectId: claims.projectId },
      ...claims,
      postId: claims.postId,
    };
  }

  private async titleOrInvalid(scope: FeedbackScope, postId: string): Promise<string> {
    try {
      return await this.deps.boards.postTitle(scope, postId);
    } catch (error) {
      if (error instanceof FeedbackPostNotFoundError) {
        throw new FeedbackLinkInvalidError({ cause: error });
      }
      throw error;
    }
  }

  canSendMail(): boolean {
    return this.deps.email !== undefined;
  }

  /** The signed one-click link that stops the end user's mail about the post. */
  unsubscribeUrlOf(scope: FeedbackScope, postId: string, endUserId: string): string {
    const token = this.deps.tokens.issue(FeedbackLinkPurposes.unsubscribe, { ...scope, endUserId, postId }, this.now());
    return `${this.deps.appOrigin}${LINK_BASE}/unsubscribe/${encodeURIComponent(token)}`;
  }

  /** Vote for the post as `email`, pending, and mail the address its confirmation link. */
  async start(scope: FeedbackScope, input: { email: string; postId: string; source: PublicVoteSource }): Promise<void> {
    const { email } = this.deps;
    if (email === undefined) {
      throw new FeedbackMailUnavailableError('no email sender');
    }
    const endUserId = emailEndUserIdOf(input.email);
    await this.deps.boards.vote(scope, input.postId, endUserId, input.source, FeedbackVoteStates.pending);
    const postTitle = await this.deps.boards.postTitle(scope, input.postId);
    const token = this.deps.tokens.issue(FeedbackLinkPurposes.identify, { ...scope, endUserId }, this.now());
    const result = await email.send(
      renderIdentifyMail({
        to: input.email.trim(),
        postTitle,
        confirmUrl: `${this.deps.appOrigin}${LINK_BASE}/identify/email/confirm?token=${encodeURIComponent(token)}`,
        unsubscribeUrl: this.unsubscribeUrlOf(scope, input.postId, endUserId),
      }),
    );
    if (result.kind !== EmailResultKinds.sent) {
      throw new FeedbackMailUnavailableError(result.kind);
    }
  }

  /** Count the pending votes of the address the link names; how many it counted. */
  async confirm(token: string): Promise<{ counted: number }> {
    const claims = this.deps.tokens.verify(FeedbackLinkPurposes.identify, token, this.now());
    if (claims === null) {
      throw new FeedbackLinkInvalidError();
    }
    const scope = { workspaceId: claims.workspaceId, projectId: claims.projectId };
    const postIds = await new FeedbackVoteRepo(this.deps.db).pendingPostIds(
      scope,
      claims.endUserId,
      PENDING_VOTE_TTL_MS,
    );
    const confirmed = await postIds.reduce<Promise<number>>(async (previous, postId) => {
      const done = await previous;
      try {
        await this.deps.votes.confirm(scope, postId, claims.endUserId);
        return done + 1;
      } catch (error) {
        // A post merged or deleted since the vote: that vote has nothing left to count on.
        if (error instanceof FeedbackPostMergedError || error instanceof FeedbackPostNotFoundError) {
          return done;
        }
        throw error;
      }
    }, Promise.resolve(0));
    return { counted: confirmed };
  }

  /** The post an unsubscribe link is about, for the page that asks first. */
  async describeUnsubscribe(token: string): Promise<{ postTitle: string }> {
    const claims = this.claimsOfUnsubscribe(token);
    return { postTitle: await this.titleOrInvalid(claims.scope, claims.postId) };
  }

  /** Stop the end user's mail about the post (or, for a merged duplicate, about the post it was
   * merged into, which took its subscribers). Idempotent. */
  async unsubscribe(token: string): Promise<{ postTitle: string }> {
    const { scope, postId, endUserId } = this.claimsOfUnsubscribe(token);
    const postTitle = await this.titleOrInvalid(scope, postId);
    try {
      await this.deps.boards.setSubscribed(scope, postId, endUserId, false);
    } catch (error) {
      if (!(error instanceof FeedbackPostMergedError)) {
        throw error;
      }
      await this.deps.boards.setSubscribed(scope, error.intoPostId, endUserId, false);
    }
    return { postTitle };
  }
}
