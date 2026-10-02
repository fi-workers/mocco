import { describe, expect, it } from 'vitest';

import { promote } from './promote';

const API = 'https://mocco.test/api/ext/v1';

/** A Mocco stand-in whose release reports `statuses` in turn, then accepts the promotion. */
function fakeMocco(statuses: readonly string[]) {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl = async (input: string | URL | Request, request?: RequestInit) => {
    const url = String(input);
    calls.push(`${request?.method ?? 'GET'} ${url.replace(API, '')}`);
    if (url.endsWith('/promotions')) {
      return Response.json({ channel: 'staging', releaseId: 'r1', platforms: ['ios'], changed: true }, { status: 201 });
    }
    const status = statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    return Response.json({ id: 'r1', status });
  };
  return { calls, fetch: fetchImpl };
}

const options = (mocco: ReturnType<typeof fakeMocco>) => ({
  apiBase: API,
  appId: 'app',
  apiKey: 'mk_sec_x',
  releaseId: 'r1',
  channel: 'staging',
  fetch: mocco.fetch,
  sleep: async () => {},
});

describe('promote', () => {
  it('waits for the release to be ready, then promotes it', async () => {
    const mocco = fakeMocco(['verifying', 'verifying', 'ready']);

    const result = await promote(options(mocco));

    expect(result.changed).toBe(true);
    expect(mocco.calls).toEqual([
      'GET /ota/apps/app/releases/r1',
      'GET /ota/apps/app/releases/r1',
      'GET /ota/apps/app/releases/r1',
      'POST /ota/apps/app/releases/r1/promotions',
    ]);
  });

  it('stops on a failed release without promoting', async () => {
    const mocco = fakeMocco(['failed']);

    await expect(promote(options(mocco))).rejects.toThrow(/is failed; it can't be promoted/u);
    expect(mocco.calls).toEqual(['GET /ota/apps/app/releases/r1']);
  });
});
