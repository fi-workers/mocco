import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stage0FromEnv } from '@backend/domain/ops/config';
import { HttpHeartbeat } from '@backend/domain/ops/heartbeat';

const PING_URL = 'https://hc-ping.com/0b1c2d3e-0000-4000-8000-000000000000';
const SOURCE_ID = '7a3e1c2b-0000-4000-8000-000000000000';
const box = { open: () => 'secret' };

describe('stage0FromEnv', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is off with neither variable set, silently', () => {
    expect(stage0FromEnv({}, { fetch, box })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('is off with only one of them set, and says so', () => {
    expect(stage0FromEnv({ OPS_HEARTBEAT_URL: PING_URL }, { fetch, box })).toBeUndefined();
    expect(stage0FromEnv({ OPS_CANARY_SOURCE_ID: SOURCE_ID }, { fetch, box })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('is on with both', () => {
    const stage0 = stage0FromEnv({ OPS_HEARTBEAT_URL: PING_URL, OPS_CANARY_SOURCE_ID: SOURCE_ID }, { fetch, box });

    expect(stage0).toMatchObject({ sourceId: SOURCE_ID, box });
    expect(stage0?.heartbeat).toBeInstanceOf(HttpHeartbeat);
  });
});

describe('HttpHeartbeat', () => {
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GETs the URL', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const heartbeat = new HttpHeartbeat({
      url: PING_URL,
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return await Promise.resolve(new Response('OK'));
      },
    });

    await heartbeat.ping();

    expect(calls).toEqual([{ url: PING_URL, method: 'GET' }]);
    expect(error).not.toHaveBeenCalled();
  });

  it('never throws, and never logs the URL (it carries the token)', async () => {
    const failing = new HttpHeartbeat({
      url: PING_URL,
      fetch: async () => await Promise.reject(new TypeError(PING_URL)),
    });
    const refused = new HttpHeartbeat({
      url: PING_URL,
      fetch: async () => await Promise.resolve(new Response('nope', { status: 404 })),
    });

    await expect(failing.ping()).resolves.toBeUndefined();
    await expect(refused.ping()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error.mock.calls)).not.toContain('hc-ping.com');
  });
});
