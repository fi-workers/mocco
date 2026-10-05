// OG images on the ext app (ADR 0030): `GET /og/v1/<template>/<signature>.png?d=<data>`,
// public and unauthenticated — the signature is the authorization. next.config.ts rewrites
// `/og/v1/*` on every host here, so a help center's cards come from its own domain.
import { Hono } from 'hono';

import { OG_CACHE_CONTROL } from '@backend/domain/og/OgImageService';

import type { OgImageService } from '@backend/domain/og/OgImageService';

/** `og` undefined (no AUTH_SECRET to verify signatures with) → every request 404s. */
export function createOgRoutes(og: Pick<OgImageService, 'image'> | undefined): Hono {
  const app = new Hono();
  app.get('/og/v1/:template/:file', async c => {
    const png = await og?.image(c.req.param('template'), c.req.param('file'), c.req.query('d'));
    if (png === undefined) {
      return c.text('not found', 404);
    }
    return c.body(new Uint8Array(png).buffer, 200, { 'Content-Type': 'image/png', 'Cache-Control': OG_CACHE_CONTROL });
  });
  return app;
}
