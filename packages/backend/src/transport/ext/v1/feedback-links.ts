// /v1/feedback voting by email and the signed mail links (#174). `POST /identify/email` takes a
// key with feedback:write: it records a pending vote for the address and mails it a confirmation
// link. The links take no key; the signed token is the credential. The confirmation link counts
// the address's pending votes. The unsubscribe link asks first (GET), so a mail scanner opening
// it unsubscribes nobody, and the form or the mail client's one-click POST (RFC 8058) does it.
// Every route is limited per client address, and an email vote also per address mailed.
import { createHash } from 'node:crypto';

import { ApiScopes } from '@mocco/common/apikey';
import {
  FeedbackIdentifyStatuses,
  feedbackV1IdentifyEmailInputSchema,
  feedbackV1IdentifyEmailResultSchema,
} from '@mocco/common/feedback-v1';
import { Hono } from 'hono';

import { FeedbackLinkInvalidError, FeedbackMailUnavailableError } from '@backend/domain/feedback/errors';
import { FeedbackLinkPageKinds, renderLinkPage } from '@backend/domain/feedback/link-mail';
import { ipBucketOf, limit, requireKey } from '@backend/transport/ext/v1/middleware';
import { parseJson, problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { EmailVoteService } from '@backend/domain/feedback/EmailVoteService';
import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';
import type { Context, MiddlewareHandler } from 'hono';
import type { z } from 'zod';

export const FeedbackLinkRateLimits = {
  /** Email votes per client address. */
  identifyPerClient: { limit: 10, windowSeconds: 600 },
  /** Email votes (so mails) per address mailed, per project. */
  identifyPerEmail: { limit: 3, windowSeconds: 3600 },
  /** The confirm and unsubscribe links, per client address. */
  links: { limit: 30, windowSeconds: 60 },
} as const;

/** The pages a link opens are for one person: never cached, indexed or leaked by referrer. */
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
};

const mailUnavailable = () =>
  problemResponse(
    problemOf(503, ProblemCodes.emailUnavailable, "This server doesn't send email, so it takes no email votes"),
  );

export function createFeedbackLinkRoutes(
  deps: V1Deps,
  links: {
    emailVotes:
      Pick<EmailVoteService, 'canSendMail' | 'start' | 'confirm' | 'describeUnsubscribe' | 'unsubscribe'> | undefined;
    answer: (work: () => Promise<Response>) => Promise<Response>;
    send: <S extends z.ZodType>(c: Context, schema: S, body: z.input<S>, status?: 200 | 201 | 202) => Response;
    /** Who may start an email vote: a key with feedback:write, or a public board's site. */
    write?: MiddlewareHandler<V1Env>;
  },
): Hono<V1Env> {
  const app = new Hono<V1Env>();
  const { emailVotes } = links;

  app.post('/identify/email', links.write ?? requireKey(deps, { scope: ApiScopes.feedbackWrite }), async c => {
    if (emailVotes?.canSendMail() !== true) {
      return mailUnavailable();
    }
    const perClient = await limit(
      deps,
      `feedback:identify:ip:${ipBucketOf(c)}`,
      FeedbackLinkRateLimits.identifyPerClient,
    );
    if (perClient.refused !== undefined) {
      return perClient.refused;
    }
    const body = await parseJson(c, feedbackV1IdentifyEmailInputSchema);
    if (body.refused !== undefined) {
      return body.refused;
    }
    const { workspaceId, projectId } = c.var.principal;
    const address = createHash('sha256')
      .update(projectId)
      .update('\n')
      .update(body.data.email.trim().toLowerCase())
      .digest('hex');

    const perEmail = await limit(
      deps,
      `feedback:identify:email:${address.slice(0, 32)}`,
      FeedbackLinkRateLimits.identifyPerEmail,
    );
    if (perEmail.refused !== undefined) {
      return perEmail.refused;
    }
    return await links.answer(async () => {
      try {
        await emailVotes.start({ workspaceId, projectId }, body.data);
      } catch (error) {
        if (error instanceof FeedbackMailUnavailableError) {
          return mailUnavailable();
        }
        throw error;
      }
      return links.send(
        c,
        feedbackV1IdentifyEmailResultSchema,
        { status: FeedbackIdentifyStatuses.pendingConfirmation },
        202,
      );
    });
  });

  /** Run a link's action and show its page; an invalid link gets the "not valid" page. */
  const onLink = async (c: Context, act: () => Promise<string>) => {
    const limited = await limit(deps, `feedback:link:ip:${ipBucketOf(c)}`, FeedbackLinkRateLimits.links);
    if (limited.refused !== undefined) {
      return limited.refused;
    }
    try {
      return c.body(await act(), 200, PAGE_HEADERS);
    } catch (error) {
      if (error instanceof FeedbackLinkInvalidError) {
        return c.body(renderLinkPage(FeedbackLinkPageKinds.invalid), 400, PAGE_HEADERS);
      }
      throw error;
    }
  };
  const required = () => {
    if (emailVotes === undefined) {
      throw new FeedbackLinkInvalidError();
    }
    return emailVotes;
  };

  app.get(
    '/identify/email/confirm',
    async c =>
      await onLink(c, async () => {
        const { counted } = await required().confirm(c.req.query('token') ?? '');
        return renderLinkPage(FeedbackLinkPageKinds.confirmed, { counted });
      }),
  );

  // Asks first: a mail scanner opening the link must not unsubscribe anyone.
  app.get(
    '/unsubscribe/:token',
    async c =>
      await onLink(c, async () => {
        const { postTitle } = await required().describeUnsubscribe(c.req.param('token') ?? '');
        return renderLinkPage(FeedbackLinkPageKinds.unsubscribeAsk, { postTitle, formAction: c.req.path });
      }),
  );

  // The form on that page, and one-click unsubscribing from the mail client (RFC 8058).
  app.post(
    '/unsubscribe/:token',
    async c =>
      await onLink(c, async () => {
        const { postTitle } = await required().unsubscribe(c.req.param('token') ?? '');
        return renderLinkPage(FeedbackLinkPageKinds.unsubscribed, { postTitle });
      }),
  );

  return app;
}
