import { describe, expect, it, vi } from 'vitest';

import { MoccoError, MoccoKeyError } from './errors';
import { FeedbackClient } from './feedback';

const BASE = 'https://mocco.test/v1';

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

/** A fetch that records each call and answers with `route(call)`. */
function fakeFetch(route: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers: new Headers(init.headers),
      body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
    };
    calls.push(call);
    return await Promise.resolve(route(call));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const problem = (status: number, code: string) =>
  Response.json({ type: `https://mocco.dev/problems/${code}`, title: code }, { status });

describe('FeedbackClient', () => {
  it('refuses a key that is not publishable', () => {
    expect(() => new FeedbackClient({ publishableKey: 'mk_sec_x' })).toThrow(MoccoKeyError);
  });

  it('reads a board, its posts and its changelog with the key alone', async () => {
    const { calls, fetchImpl } = fakeFetch(call => {
      if (call.url.endsWith('/boards/ideas')) {
        return Response.json({ board: { slug: 'ideas', name: 'Ideas', categories: [] } });
      }
      return call.url.includes('/posts')
        ? Response.json({ posts: [], nextOffset: null })
        : Response.json({ entries: [], nextOffset: null });
    });
    const feedback = new FeedbackClient({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      endUserToken: () => 'jwt-1',
    });
    const board = feedback.board('ideas');

    expect(await board.get()).toEqual({ slug: 'ideas', name: 'Ideas', categories: [] });
    await board.posts({ status: 'planned', sort: 'new', limit: 5 });
    await board.changelog({ limit: 3, offset: 3 });

    expect(calls.map(call => call.url)).toEqual([
      `${BASE}/feedback/boards/ideas`,
      `${BASE}/feedback/boards/ideas/posts?status=planned&sort=new&limit=5`,
      `${BASE}/feedback/boards/ideas/changelog?limit=3&offset=3`,
    ]);
    // Reads that don't depend on the viewer never send the end user's token.
    expect(calls.map(call => call.headers.get('authorization'))).toEqual(
      Array.from({ length: 3 }, () => 'Bearer mk_pub_x'),
    );
    expect(calls.map(call => call.headers.get('x-mocco-key'))).toEqual([null, null, null]);
  });

  it('votes with the end-user token and the key in X-Mocco-Key, asking for the token once', async () => {
    const tokenSource = vi.fn(async () => await Promise.resolve('jwt-1'));
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ vote: 'counted', voteCount: 3 }));
    const feedback = new FeedbackClient({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      endUserToken: tokenSource,
    });

    expect(await feedback.vote('p1')).toEqual({ vote: 'counted', voteCount: 3 });
    await feedback.unvote('p1');

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      `POST ${BASE}/feedback/posts/p1/vote`,
      `DELETE ${BASE}/feedback/posts/p1/vote`,
    ]);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer jwt-1');
    expect(calls[0]?.headers.get('x-mocco-key')).toBe('mk_pub_x');
    expect(tokenSource).toHaveBeenCalledTimes(1);
  });

  it('refuses a vote without an end user, before any request', async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({}));
    const feedback = new FeedbackClient({ publishableKey: 'mk_pub_x', baseUrl: BASE, fetch: fetchImpl });

    await expect(feedback.vote('p1')).rejects.toBeInstanceOf(MoccoError);
    await expect(feedback.vote('p1')).rejects.toMatchObject({ code: 'missing_end_user_token' });
    expect(calls).toHaveLength(0);
  });

  it('asks for a fresh token once when Mocco refuses an expired one', async () => {
    let tokens = 0;
    const { calls, fetchImpl } = fakeFetch(call =>
      call.headers.get('authorization') === 'Bearer jwt-1'
        ? problem(401, 'invalid_end_user_token')
        : Response.json({ vote: 'counted', voteCount: 1 }),
    );
    const feedback = new FeedbackClient({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      endUserToken: () => {
        tokens += 1;
        return `jwt-${tokens}`;
      },
    });

    expect(await feedback.vote('p1')).toEqual({ vote: 'counted', voteCount: 1 });
    expect(calls.map(call => call.headers.get('authorization'))).toEqual(['Bearer jwt-1', 'Bearer jwt-2']);
  });

  it('gives up after one fresh token', async () => {
    const { calls, fetchImpl } = fakeFetch(() => problem(401, 'invalid_end_user_token'));
    const feedback = new FeedbackClient({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      endUserToken: () => 'jwt',
    });

    await expect(feedback.vote('p1')).rejects.toMatchObject({ code: 'invalid_end_user_token' });
    expect(calls).toHaveLength(2);
  });

  it('reads a post with the viewer when signed in, and anonymously otherwise', async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ post: { id: 'p1' }, viewer: null }));
    let token: string | null = null;
    const feedback = new FeedbackClient({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      endUserToken: () => token,
    });

    await feedback.post('p1');
    token = 'jwt';
    feedback.resetEndUser();
    await feedback.post('p1');

    expect(calls.map(call => call.headers.get('authorization'))).toEqual(['Bearer mk_pub_x', 'Bearer jwt']);
  });
});
