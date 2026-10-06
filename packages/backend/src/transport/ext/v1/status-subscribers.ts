// /v1/status-pages/:slug/subscribers (#156): a visitor of a public status page signs up for its
// updates by email (the page's form) or with a webhook URL, and the signed links confirm or end
// the subscription. No API key: the page's slug is public, and the links carry signed tokens.
// Sign-ups are limited per client address and per address or URL signed up. An email sign-up
// answers `202` the same whether the address is new, pending or already subscribed (so the
// route tells nobody who follows a page), and a filled honeypot field (`website`) is answered
// the same and otherwise ignored. A webhook sign-up answers with its signing secret, once. A
// plain form post (the page without its script) gets a page back instead of JSON. The routes
// only parse; the SubscriberService decides.
import { createHash } from 'node:crypto';

import { statusSubscribeInputSchema, SubscriberChannels, SubscriberLocales } from '@mocco/common/status';
import { Hono } from 'hono';

import {
  StatusEntityNotFoundError,
  SubscriberComponentError,
  SubscriberTokenError,
  SubscriberWebhookUrlError,
} from '@backend/domain/status/errors';
import { renderSubscriberPage, SubscriberPageKinds } from '@backend/domain/status/subscriber-mail';
import { SubscribeOutcomes, SubscriberRateLimits } from '@backend/domain/status/SubscriberService';
import { ipBucketOf, limit } from '@backend/transport/ext/v1/middleware';
import { problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { SubscriberPageKind } from '@backend/domain/status/subscriber-mail';
import type { SubscriberService } from '@backend/domain/status/SubscriberService';
import type { V1Deps } from '@backend/transport/ext/v1/middleware';
import type { StatusSubscribeInput, SubscriberLocale } from '@mocco/common/status';
import type { Context } from 'hono';

export interface StatusSubscriberDeps {
  subscribers: Pick<
    SubscriberService,
    | 'canSendMail'
    | 'canTakeWebhooks'
    | 'subscribe'
    | 'subscribeWebhook'
    | 'confirm'
    | 'describeUnsubscribe'
    | 'unsubscribe'
  >;
}

/** The pages a link opens are for one person: never cached, indexed or leaked by referrer. */
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
};

/** The status page script posts from the page's own origin, which is never the app's. */
const PUBLIC_CORS = { 'Access-Control-Allow-Origin': '*' };

/** The visitor's language, from Accept-Language, for a page shown before a subscriber is known. */
function localeOf(c: Context): SubscriberLocale {
  const first = c.req.header('accept-language')?.split(',', 1)[0]?.trim().toLowerCase() ?? '';
  // eslint-disable-next-line sonarjs/null-dereference -- defaulted to '' above, never null
  return first.startsWith('ko') ? SubscriberLocales.ko : SubscriberLocales.en;
}

/** Whether the caller is a browser posting the form without the page's script: it asks for HTML. */
function isPagePost(c: Context): boolean {
  const accept = c.req.header('accept') ?? '';
  const type = c.req.header('content-type') ?? '';
  // eslint-disable-next-line sonarjs/null-dereference -- defaulted to '' above, never null
  return accept.includes('text/html') && !type.includes('application/json');
}

/** A link back to the status page the form was on, when the browser said which page it was. */
function backLinkOf(c: Context): { backUrl?: string } {
  const referer = c.req.header('referer');
  if (referer === undefined || !URL.canParse(referer)) {
    return {};
  }
  const { protocol } = new URL(referer);
  return protocol === 'https:' || protocol === 'http:' ? { backUrl: referer } : {};
}

/** The sign-up body, as JSON or as a plain form post (repeated `componentIds` fields). */
async function bodyOf(c: Context): Promise<unknown> {
  const type = c.req.header('content-type') ?? '';
  try {
    // eslint-disable-next-line sonarjs/null-dereference -- defaulted to '' above, never null
    if (type.includes('application/json')) {
      return await c.req.json();
    }
    const form = await c.req.parseBody({ all: true });
    const { componentIds, ...fields } = form;
    return {
      ...fields,
      ...(componentIds !== undefined && { componentIds: [componentIds].flat() }),
    };
  } catch {
    return null;
  }
}

function page(
  c: Context,
  kind: SubscriberPageKind,
  opts: { locale: SubscriberLocale; pageTitle: string },
  status: 200 | 400,
) {
  const formAction =
    kind === SubscriberPageKinds.unsubscribeAsk
      ? `?token=${encodeURIComponent(c.req.query('token') ?? '')}`
      : undefined;
  return c.body(
    renderSubscriberPage(kind, { ...opts, ...(formAction !== undefined && { formAction }) }),
    status,
    PAGE_HEADERS,
  );
}

/** A sign-up's answer before it is written as JSON or as a page. */
interface Answer {
  status: 202 | 400 | 404 | 409 | 429 | 503;
  title?: string;
  /** A new webhook's signing secret, shown this once. */
  secret?: string;
  /** The limiter's own 429, with its headers. */
  refused?: Response;
}

const UNAVAILABLE = {
  webhook: "This server doesn't take webhook subscriptions",
  email: "This server doesn't send email, so it takes no email subscriptions",
} as const;

const PROBLEM_CODES = {
  400: ProblemCodes.badRequest,
  404: ProblemCodes.notFound,
  409: ProblemCodes.conflict,
  429: ProblemCodes.rateLimited,
  503: ProblemCodes.subscriptionsUnavailable,
} as const;

/** The answer for a domain error of a sign-up; anything else is rethrown. */
function answerOfError(error: unknown): Answer {
  if (error instanceof SubscriberComponentError) {
    return { status: 400, title: "componentIds names a component that isn't on this page" };
  }
  if (error instanceof SubscriberWebhookUrlError) {
    return { status: 400, title: error.message };
  }
  if (error instanceof StatusEntityNotFoundError) {
    return { status: 404, title: 'No such status page' };
  }
  throw error;
}

function answerAsJson(c: Context, answer: Answer): Response {
  if (answer.refused !== undefined) {
    return answer.refused;
  }
  if (answer.status === 202) {
    const secret = answer.secret === undefined ? {} : { secret: answer.secret };
    return c.json({ status: 'pending_confirmation', ...secret }, 202, PUBLIC_CORS);
  }
  return problemResponse(
    problemOf(answer.status, PROBLEM_CODES[answer.status], answer.title ?? 'Not subscribed'),
    PUBLIC_CORS,
  );
}

function answerAsPage(c: Context, answer: Answer): Response {
  const kind = answer.status === 202 ? SubscriberPageKinds.pending : SubscriberPageKinds.failed;
  const status = answer.status === 404 || answer.status === 409 ? 400 : answer.status;
  const html = renderSubscriberPage(kind, {
    locale: localeOf(c),
    pageTitle: c.req.param('slug') ?? '',
    ...backLinkOf(c),
  });
  return c.body(html, status, PAGE_HEADERS);
}

export function createStatusSubscriberRoutes(deps: V1Deps, subscribers: StatusSubscriberDeps): Hono {
  const app = new Hono();
  const service = subscribers.subscribers;

  /** Sign up from a parsed body. */
  const signUp = async (slug: string, input: StatusSubscribeInput): Promise<Answer> => {
    const isWebhook = input.channel === SubscriberChannels.webhook;
    if (isWebhook ? !service.canTakeWebhooks() : !service.canSendMail()) {
      return { status: 503, title: UNAVAILABLE[isWebhook ? 'webhook' : 'email'] };
    }
    try {
      if (input.channel === SubscriberChannels.webhook) {
        const { outcome, secret } = await service.subscribeWebhook(slug, input);
        return outcome === SubscribeOutcomes.alreadySubscribed
          ? { status: 409, title: 'This URL already follows the page; unsubscribe it first to replace its secret' }
          : { status: 202, ...(secret !== undefined && { secret }) };
      }
      const { website, ...email } = input;
      // The honeypot: a person never sees the field.
      if (website === undefined || website.trim() === '') {
        await service.subscribe(slug, email);
      }
      return { status: 202 };
    } catch (error) {
      return answerOfError(error);
    }
  };

  /** Limit, parse and sign up. */
  const handle = async (c: Context): Promise<Answer> => {
    const slug = c.req.param('slug') ?? '';
    const perClient = await limit(deps, `status-subscribe-ip:${ipBucketOf(c)}`, SubscriberRateLimits.perClient);
    if (perClient.refused !== undefined) {
      return { status: 429, refused: perClient.refused };
    }
    const body = statusSubscribeInputSchema.safeParse(await bodyOf(c));
    if (!body.success) {
      return { status: 400, title: 'Send { email } or { channel: "webhook", url } (and optionally componentIds)' };
    }
    const target = body.data.channel === SubscriberChannels.webhook ? body.data.url : body.data.email;
    const address = createHash('sha256').update(`${slug}:${target}`).digest('hex').slice(0, 32);
    const perAddress = await limit(deps, `status-subscribe-email:${address}`, SubscriberRateLimits.perEmail);
    if (perAddress.refused !== undefined) {
      return { status: 429, refused: perAddress.refused };
    }
    return await signUp(slug, body.data);
  };

  app.post('/:slug/subscribers', async c => {
    const answer = await handle(c);
    // A plain form post from the status page (no script): answer with a page, not JSON.
    return isPagePost(c) ? answerAsPage(c, answer) : answerAsJson(c, answer);
  });

  /** Run a link's action; an invalid link gets the "not valid" page. */
  const onLink = async (
    c: Context,
    act: (slug: string, token: string) => Promise<{ pageTitle: string; locale: SubscriberLocale }>,
    kind: SubscriberPageKind,
  ) => {
    const limited = await limit(deps, `status-subscriber-link:${ipBucketOf(c)}`, SubscriberRateLimits.links);
    if (limited.refused !== undefined) {
      return limited.refused;
    }
    const slug = c.req.param('slug') ?? '';
    try {
      return page(c, kind, await act(slug, c.req.query('token') ?? ''), 200);
    } catch (error) {
      if (error instanceof SubscriberTokenError) {
        return page(c, SubscriberPageKinds.invalid, { locale: localeOf(c), pageTitle: slug }, 400);
      }
      throw error;
    }
  };

  app.get(
    '/:slug/subscribers/confirm',
    async c =>
      await onLink(c, async (slug, token) => await service.confirm(slug, token), SubscriberPageKinds.confirmed),
  );

  // Asks first: a mail scanner opening the link must not unsubscribe anyone.
  app.get(
    '/:slug/subscribers/unsubscribe',
    async c =>
      await onLink(
        c,
        async (slug, token) => await service.describeUnsubscribe(slug, token),
        SubscriberPageKinds.unsubscribeAsk,
      ),
  );

  // The form on that page, and one-click unsubscribing from the mail client (RFC 8058).
  app.post(
    '/:slug/subscribers/unsubscribe',
    async c =>
      await onLink(c, async (slug, token) => await service.unsubscribe(slug, token), SubscriberPageKinds.unsubscribed),
  );

  return app;
}
