// /v1/ping/:token (#153): a heartbeat monitor's job pings Mocco, with GET or POST so a curl or wget
// one-liner works: `/:token` when it finished, `/:token/start` when it started, `/:token/fail` when
// it failed, `/:token/:exitCode` with its exit code (0 is a success). No API key: the token is the
// credential. A token of the wrong shape, or one that matches no heartbeat, gets the ext app's own
// 404, so a ping can't tell a wrong token from a missing route. Limits apply per client address
// and per token (hashed, before the lookup, so an unknown token is limited the same way). The
// routes only parse; HeartbeatService decides.
import { createHash } from 'node:crypto';

import { HEARTBEAT_TOKEN_PATTERN, HeartbeatLimits } from '@mocco/common/status';
import { Hono } from 'hono';

import { HeartbeatSignals } from '@backend/domain/status/heartbeat';
import { ipBucketOf, limit } from '@backend/transport/ext/v1/middleware';

import type { RateLimitRule } from '@backend/domain/ratelimit/ports';
import type { HeartbeatPing, HeartbeatService } from '@backend/domain/status/HeartbeatService';
import type { V1Deps } from '@backend/transport/ext/v1/middleware';
import type { Context } from 'hono';

export interface HeartbeatPingDeps {
  heartbeats: Pick<HeartbeatService, 'ping'>;
}

/** Per token: one ping a second on average, with room for a start and its finish. */
export const PING_TOKEN_RATE_LIMIT: RateLimitRule = {
  limit: HeartbeatLimits.pingsPerWindow,
  windowSeconds: HeartbeatLimits.pingWindowSeconds,
};
/** Per client address: many jobs on one host each ping on their own token. */
export const PING_ADDRESS_RATE_LIMIT: RateLimitRule = { limit: 600, windowSeconds: 60 };

/** The largest exit code a process reports. */
const MAX_EXIT_CODE = 255;
const PING_METHODS = ['GET', 'POST'];

async function handlePing(deps: V1Deps, heartbeats: HeartbeatPingDeps, c: Context, ping: HeartbeatPing) {
  const address = await limit(deps, `ping-ip:${ipBucketOf(c)}`, PING_ADDRESS_RATE_LIMIT);
  if (address.refused !== undefined) {
    return address.refused;
  }
  const token = c.req.param('token') ?? '';
  if (!HEARTBEAT_TOKEN_PATTERN.test(token)) {
    return await c.notFound();
  }
  const bucket = createHash('sha256').update(token).digest('hex').slice(0, 32);
  const perToken = await limit(deps, `ping:${bucket}`, PING_TOKEN_RATE_LIMIT);
  if (perToken.refused !== undefined) {
    return perToken.refused;
  }
  if (!(await heartbeats.heartbeats.ping(token, ping))) {
    return await c.notFound();
  }
  return c.text('OK', 200, { 'Cache-Control': 'no-store' });
}

export function createHeartbeatPingRoutes(deps: V1Deps, heartbeats: HeartbeatPingDeps): Hono {
  const app = new Hono();

  app.on(
    PING_METHODS,
    '/:token',
    async c => await handlePing(deps, heartbeats, c, { signal: HeartbeatSignals.success }),
  );
  app.on(
    PING_METHODS,
    '/:token/start',
    async c => await handlePing(deps, heartbeats, c, { signal: HeartbeatSignals.start }),
  );
  app.on(
    PING_METHODS,
    '/:token/fail',
    async c => await handlePing(deps, heartbeats, c, { signal: HeartbeatSignals.fail }),
  );
  app.on(PING_METHODS, '/:token/:exitCode{[0-9]{1,3}}', async c => {
    const exitCode = Number(c.req.param('exitCode'));
    if (exitCode > MAX_EXIT_CODE) {
      return await c.notFound();
    }
    return await handlePing(deps, heartbeats, c, {
      signal: exitCode === 0 ? HeartbeatSignals.success : HeartbeatSignals.fail,
      exitCode,
    });
  });

  return app;
}
