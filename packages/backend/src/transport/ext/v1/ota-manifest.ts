// The device-facing OTA routes (ADR 0021): the Expo Updates protocol v1 manifest endpoint
// a stock expo-updates client polls, and the asset route its manifests point at. Both are
// public. An unknown app, channel or runtime is a 204 (no update), never a 404, so apps
// can't be enumerated and a misconfigured build keeps running its embedded bundle.
import { clientEventsRequestSchema, OTA_EVENTS_MAX_BYTES, otaPlatformSchema } from '@mocco/common/ota-hosting';
import { Hono } from 'hono';
import { z } from 'zod';

import { multipartOf, signatureOf } from '@backend/domain/ota/serving/multipart';
import { limitAnonymous } from '@backend/transport/ext/v1/middleware';

import type { OtaMetricsService } from '@backend/domain/ota/OtaMetricsService';
import type { UpdateCheckService } from '@backend/domain/ota/UpdateCheckService';
import type { V1Deps } from '@backend/transport/ext/v1/middleware';
import type { Context } from 'hono';

export interface OtaServingDeps {
  updateChecks: Pick<UpdateCheckService, 'check' | 'assetUrl'>;
  metrics: Pick<OtaMetricsService, 'recordEvents'>;
}

const PROTOCOL_HEADERS = {
  'expo-protocol-version': '1',
  'expo-sfv-version': '0',
  'cache-control': 'private, max-age=0',
};

const uuidSchema = z.uuid();
const assetHashSchema = z.string().regex(/^[\w-]{43}$/u);

/** The no-op answer: no update, and the protocol headers expo-updates requires even on a 204. */
const noUpdate = () => new Response(null, { status: 204, headers: PROTOCOL_HEADERS });

/** Whether the client takes `multipart/mixed` (every expo-updates release does), or only JSON. */
function isMultipartAccepted(c: Context): boolean {
  const accept = c.req.header('accept') ?? '*/*';
  // eslint-disable-next-line sonarjs/null-dereference -- defaulted above, never null
  return accept.includes('multipart/mixed') || accept.includes('*/*');
}

export function createOtaServingRoutes(v1: V1Deps, deps: OtaServingDeps): Hono {
  const app = new Hono();

  // Launches, emergency launches and errors from the app (public: devices hold no key).
  // Size-capped and rate-limited; an unknown app is accepted and dropped, like a 204.
  app.post('/apps/:appId/events', limitAnonymous(v1), async c => {
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > OTA_EVENTS_MAX_BYTES) {
      return c.text('events are limited to 16 KB per request', 413);
    }
    const text = await c.req.text();
    if (text.length > OTA_EVENTS_MAX_BYTES) {
      return c.text('events are limited to 16 KB per request', 413);
    }
    const appId = c.req.param('appId');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return c.text('the body must be JSON', 400);
    }
    const parsed = clientEventsRequestSchema.safeParse(json);
    if (!parsed.success) {
      return c.text(parsed.error.issues[0]?.message ?? 'invalid events', 400);
    }
    if (uuidSchema.safeParse(appId).success) {
      await deps.metrics.recordEvents(appId, parsed.data);
    }
    return c.body(null, 202);
  });

  app.get('/apps/:appId/manifest', async c => {
    if (c.req.header('expo-protocol-version') !== '1') {
      return c.text('Mocco serves Expo Updates protocol version 1 (expo-updates 0.17 or later)', 400, PROTOCOL_HEADERS);
    }
    const platform = otaPlatformSchema.safeParse(c.req.header('expo-platform') ?? c.req.query('platform'));
    const runtimeVersion = c.req.header('expo-runtime-version') ?? c.req.query('runtime-version');
    if (!platform.success || runtimeVersion === undefined || runtimeVersion === '') {
      return c.text('expo-platform (ios or android) and expo-runtime-version are required', 400, PROTOCOL_HEADERS);
    }
    const appId = c.req.param('appId');
    const channel = c.req.header('expo-channel-name');
    if (!uuidSchema.safeParse(appId).success || channel === undefined || channel === '') {
      return noUpdate();
    }
    const selection = await deps.updateChecks.check({
      appId,
      channel,
      platform: platform.data,
      runtimeVersion,
      clientId: c.req.header('eas-client-id'),
      currentUpdateId: c.req.header('expo-current-update-id'),
      embeddedUpdateId: c.req.header('expo-embedded-update-id'),
    });
    if (selection.kind === 'noop') {
      return noUpdate();
    }
    if (isMultipartAccepted(c)) {
      const { body, contentType } = multipartOf(selection.kind === 'update' ? 'manifest' : 'directive', selection.part);
      return new Response(body, { status: 200, headers: { ...PROTOCOL_HEADERS, 'content-type': contentType } });
    }
    // A JSON-only client can take a manifest (signature as a response header), not a directive.
    if (selection.kind === 'directive') {
      return c.text('This response is a directive, which needs Accept: multipart/mixed', 406, PROTOCOL_HEADERS);
    }
    const signature = signatureOf(selection.part);
    return new Response(selection.part.body, {
      status: 200,
      headers: {
        ...PROTOCOL_HEADERS,
        'content-type': 'application/expo+json',
        ...(signature !== null && { 'expo-signature': signature }),
      },
    });
  });

  // Asset URLs in signed manifests are fixed under Mocco; this redirects to wherever the
  // bytes live (the CDN, the bucket or the filesystem driver's route). Content-addressed,
  // so the redirect is cacheable forever.
  app.get('/apps/:appId/assets/:hash', async c => {
    const appId = c.req.param('appId');
    const hash = c.req.param('hash');
    if (!uuidSchema.safeParse(appId).success || !assetHashSchema.safeParse(hash).success) {
      return c.text('not found', 404);
    }
    const url = await deps.updateChecks.assetUrl(appId, hash);
    if (url === undefined) {
      return c.text('not found', 404);
    }
    return c.redirect(url, 302);
  });

  return app;
}
