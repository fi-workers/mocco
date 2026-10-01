import { describe, expect, it } from 'vitest';

import { promote } from './promote';

const API = 'https://mocco.test/api/ext/v1';

const APPLIED = {
  channel: 'staging',
  releaseId: 'r1',
  platforms: ['ios'],
  changed: true,
  outcome: 'applied',
  requestId: null,
};
const PENDING = { ...APPLIED, channel: 'production', changed: false, outcome: 'pending_approval', requestId: 'q1' };

/** A Mocco stand-in: the release reports `statuses` in turn; the promotion applies, or —
 * with `approvals` — asks for an approval whose state goes through `approvals`. */
function fakeMocco(statuses: readonly string[], approvals: readonly string[] = []) {
  const calls: string[] = [];
  let index = 0;
  let approvalIndex = 0;
  const fetchImpl = async (input: string | URL | Request, request?: RequestInit) => {
    const url = String(input);
    calls.push(`${request?.method ?? 'GET'} ${url.replace(API, '')}`);
    if (url.endsWith('/promotions')) {
      return approvals.length === 0 ? Response.json(APPLIED, { status: 201 }) : Response.json(PENDING, { status: 202 });
    }
    if (url.includes('/promotions/')) {
      const state = approvals[Math.min(approvalIndex, approvals.length - 1)];
      approvalIndex += 1;
      return Response.json({ requestId: 'q1', state });
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

  it('waits for the approval on a protected channel, and fails on a rejection', async () => {
    const approved = fakeMocco(['ready'], ['pending', 'approved']);
    const rejected = fakeMocco(['ready'], ['pending', 'rejected']);

    await promote({ ...options(approved), channel: 'production', isWaitingForApproval: true });

    await expect(promote({ ...options(rejected), channel: 'production', isWaitingForApproval: true })).rejects.toThrow(
      /was rejected/u,
    );
    expect(approved.calls.slice(-2)).toEqual(['GET /ota/apps/app/promotions/q1', 'GET /ota/apps/app/promotions/q1']);
  });

  it('stops on a failed release without promoting', async () => {
    const mocco = fakeMocco(['failed']);

    await expect(promote(options(mocco))).rejects.toThrow(/is failed; it can't be promoted/u);
    expect(mocco.calls).toEqual(['GET /ota/apps/app/releases/r1']);
  });
});
