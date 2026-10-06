import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { V1Deps } from '@backend/transport/ext/v1/middleware';

describe('the ext route handler (frontend app/api/ext)', () => {
  it('hands every method the ext app serves to Hono, OPTIONS included', async () => {
    // Next answers a method the route file doesn't export by itself: for OPTIONS that is a
    // preflight without Access-Control-* headers, which breaks every browser SDK call.
    const route = await readFile(
      fileURLToPath(new URL('../../../../frontend/src/app/api/ext/[[...route]]/route.ts', import.meta.url)),
      'utf8',
    );
    const exported = new Set(Array.from(route.matchAll(/^export const ([A-Z]+) = /gmu), match => match[1]));
    expect(exported).toEqual(new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']));

    // Every method a /v1 route answers, with every product mounted (the routes are only built).
    const mounted = {
      status: {},
      ota: {},
      flags: {},
      messenger: {},
      runs: {},
      help: {},
      probe: {},
      heartbeats: {},
      statusSubscribers: {},
    };
    const deps = { apiKeys: {}, limiter: new MemoryRateLimiter(), ...mounted } as unknown as V1Deps;
    const served = new Set(
      createV1Routes(deps)
        .routes.map(mountedRoute => mountedRoute.method)
        .filter(method => method !== 'ALL'),
    );
    expect([...served].filter(method => !exported.has(method))).toEqual([]);
  });
});
