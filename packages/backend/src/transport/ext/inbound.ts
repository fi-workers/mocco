// The inbound webhook route (notification relay design §5, ADR 0019), mounted on the
// ext app under /api/ext. Sentry, Vercel and GitHub deliver to
// POST /api/ext/inbound/<ingestKey>. A thin adapter over InboundService.ingest:
// verify, record and publish all happen there; this route reads the body and maps the
// status to a fixed body.
import { Hono } from 'hono';

import { IngestStatuses } from '@backend/domain/inbound/constants';

import type { InboundService } from '@backend/domain/inbound/InboundService';

export const INBOUND_ROUTE = '/inbound/:ingestKey';

/** Fixed, short bodies: never a hint about the source, the secret or what failed. */
const bodies = {
  [IngestStatuses.accepted]: 'accepted',
  [IngestStatuses.badRequest]: 'missing delivery id',
  [IngestStatuses.unauthorized]: 'invalid signature',
  [IngestStatuses.notFound]: 'not found',
} as const;

/** `inbound` undefined (SECRETS_ENCRYPTION_KEYS not set, so no secret can be opened) →
 * every call 503s. */
export function createInboundRoutes(inbound: Pick<InboundService, 'ingest'> | undefined): Hono {
  const app = new Hono();
  app.post(INBOUND_ROUTE, async c => {
    if (!inbound) {
      return c.text('inbound webhooks are not configured', 503);
    }
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
  });
  return app;
}
