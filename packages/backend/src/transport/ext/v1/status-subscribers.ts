// /v1/status-pages/:slug/subscribers (#156): a visitor of a public status page signs up for its
// updates by email, and the links in the mail confirm or end the subscription. No API key: the
// page's slug is public, and the links carry signed tokens. Sign-ups are limited per client
// address and per address signed up, answer `202` the same whether the address is new, pending
// or already subscribed (so the route tells nobody who follows a page), and a filled honeypot
// field (`website`) is answered the same and otherwise ignored. The routes only parse; the
// SubscriberService decides.
import { createHash } from 'node:crypto';

import { statusSubscribeInputSchema, SubscriberLocales } from '@mocco/common/status';
import { Hono } from 'hono';

import {
  StatusEntityNotFoundError,
  SubscriberComponentError,
  SubscriberTokenError,
} from '@backend/domain/status/errors';
import { renderSubscriberPage, SubscriberPageKinds } from '@backend/domain/status/subscriber-mail';
import { SubscriberRateLimits } from '@backend/domain/status/SubscriberService';
import { ipBucketOf, limit } from '@backend/transport/ext/v1/middleware';
import { problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { SubscriberPageKind } from '@backend/domain/status/subscriber-mail';
import type { SubscriberService } from '@backend/domain/status/SubscriberService';
import type { V1Deps } from '@backend/transport/ext/v1/middleware';
import type { SubscriberLocale } from '@mocco/common/status';
import type { Context } from 'hono';

export interface StatusSubscriberDeps {
  subscribers: Pick<SubscriberService, 'canSendMail' | 'subscribe' | 'confirm' | 'describeUnsubscribe' | 'unsubscribe'>;
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

export function createStatusSubscriberRoutes(deps: V1Deps, subscribers: StatusSubscriberDeps): Hono {
  const app = new Hono();
  const service = subscribers.subscribers;

  app.post('/:slug/subscribers', async c => {
    const perClient = await limit(deps, `status-subscribe-ip:${ipBucketOf(c)}`, SubscriberRateLimits.perClient);
    if (perClient.refused !== undefined) {
      return perClient.refused;
    }
    if (!service.canSendMail()) {
      return problemResponse(
        problemOf(
          503,
          ProblemCodes.subscriptionsUnavailable,
          "This server doesn't send email, so it takes no subscriptions",
        ),
        PUBLIC_CORS,
      );
    }
    const body = statusSubscribeInputSchema.safeParse(await bodyOf(c));
    if (!body.success) {
      return problemResponse(
        problemOf(400, ProblemCodes.badRequest, 'Send { email } (and optionally componentIds, locale)'),
        PUBLIC_CORS,
      );
    }
    const accepted = () => c.json({ status: 'pending_confirmation' }, 202, PUBLIC_CORS);
    const { website, ...input } = body.data;
    if (website !== undefined && website.trim() !== '') {
      // The honeypot: a person never sees the field.
      return accepted();
    }
    const slug = c.req.param('slug');
    const address = createHash('sha256').update(`${slug}:${input.email}`).digest('hex').slice(0, 32);
    const perEmail = await limit(deps, `status-subscribe-email:${address}`, SubscriberRateLimits.perEmail);
    if (perEmail.refused !== undefined) {
      return perEmail.refused;
    }
    try {
      await service.subscribe(slug, input);
      return accepted();
    } catch (error) {
      if (error instanceof SubscriberComponentError) {
        return problemResponse(
          problemOf(400, ProblemCodes.badRequest, "componentIds names a component that isn't on this page"),
          PUBLIC_CORS,
        );
      }
      if (error instanceof StatusEntityNotFoundError) {
        return problemResponse(problemOf(404, ProblemCodes.notFound, 'No such status page'), PUBLIC_CORS);
      }
      throw error;
    }
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
