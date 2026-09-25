// The inbound webhook route (notification relay design §5, ADR 0019), mounted on the
// ext app under /api/ext. Sentry, Vercel and GitHub deliver to
// POST /api/ext/inbound/<ingestKey>. A thin adapter over InboundService.ingest:
// verify, record and publish all happen there; this route reads the body and maps the
// status to a fixed body.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { INBOUND_MAX_BODY_BYTES, INGEST_KEY_PATTERN, IngestStatuses } from '@backend/domain/inbound/constants';

import type { InboundService } from '@backend/domain/inbound/InboundService';

export const INBOUND_ROUTE = '/inbound/:ingestKey';

/** Fixed, short bodies: never a hint about the source, the secret or what failed. */
const bodies = {
  [IngestStatuses.accepted]: 'accepted',
  [IngestStatuses.badRequest]: 'missing delivery id',
  [IngestStatuses.unauthorized]: 'invalid signature',
  [IngestStatuses.notFound]: 'not found',
  [IngestStatuses.tooManyRequests]: 'too many deliveries',
} as const;

const PAYLOAD_TOO_LARGE = 413;

/** `inbound` undefined (SECRETS_ENCRYPTION_KEYS not set, so no secret can be opened) →
 * every call 503s. */
export function createInboundRoutes(inbound: Pick<InboundService, 'ingest'> | undefined): Hono {
  const app = new Hono();
  if (!inbound) {
    app.post(INBOUND_ROUTE, c => c.text('inbound webhooks are not configured', 503));
    return app;
  }
  app.post(
    INBOUND_ROUTE,
    // Cheap rejects first, before the body is read or the DB is touched: a key that
    // cannot be one we issued is a 404, and a body over the limit a 413.
    async (c, next) => {
      if (!INGEST_KEY_PATTERN.test(c.req.param('ingestKey'))) {
        return c.text(bodies[IngestStatuses.notFound], IngestStatuses.notFound);
      }
      await next();
      return undefined;
    },
    bodyLimit({
      maxSize: INBOUND_MAX_BODY_BYTES,
      onError: c => c.text('payload too large', PAYLOAD_TOO_LARGE),
    }),
    async c => {
      // The body is read as BYTES: signatures are computed over exactly what was sent,
      // and decoding to text first would alter a body with a BOM or invalid UTF-8.
      const body = new Uint8Array(await c.req.arrayBuffer());
      try {
        const result = await inbound.ingest({ ingestKey: c.req.param('ingestKey'), body, headers: c.req.raw.headers });
        return c.text(bodies[result.status], result.status);
      } catch (error) {
        // Only the error's class is logged: a failed query's message carries its
        // parameters (the ingest key, the payload).
        console.error('[inbound] ingest failed', error instanceof Error ? error.name : 'unknown error');
        return c.text('Internal server error', 500);
      }
    },
  );
  return app;
}
