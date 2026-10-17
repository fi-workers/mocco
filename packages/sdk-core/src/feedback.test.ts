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
    // Reads that don't depend on the viewer never send the end user's token; the post list
    // does, so each post says whether they voted for it.
    expect(calls.map(call => call.headers.get('authorization'))).toEqual([
      'Bearer mk_pub_x',
      'Bearer jwt-1',
      'Bearer mk_pub_x',
    ]);
    expect(calls.map(call => call.headers.get('x-mocco-key'))).toEqual([null, 'mk_pub_x', null]);
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

  it('searches similar posts and reads the roadmap with the viewer when signed in', async () => {
    const { calls, fetchImpl } = fakeFetch(call =>
      call.url.includes('/similar')
        ? Response.json({ posts: [{ id: 'p1' }] })
        : Response.json({ roadmap: { planned: [], in_progress: [], shipped: [] } }),
    );
    const feedback = new FeedbackClient({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      endUserToken: () => 'jwt',
    });
    const board = feedback.board('ideas');

    expect(await board.similar('dark mode & more', { limit: 3 })).toEqual([{ id: 'p1' }]);
    expect(await board.roadmap()).toEqual({ planned: [], in_progress: [], shipped: [] });
    expect(calls.map(call => call.url)).toEqual([
      `${BASE}/feedback/boards/ideas/similar?q=dark+mode+%26+more&limit=3`,
      `${BASE}/feedback/boards/ideas/roadmap`,
    ]);
    expect(calls.map(call => call.headers.get('authorization'))).toEqual(['Bearer jwt', 'Bearer jwt']);
  });

  it('reads a list as a visitor when the token source fails, but a write rejects', async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ posts: [], nextOffset: null }));
    const feedback = new FeedbackClient({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      endUserToken: () => {
        throw new Error('session expired');
      },
    });

    expect(await feedback.board('ideas').posts()).toEqual({ posts: [], nextOffset: null });
    expect(calls.map(call => call.headers.get('authorization'))).toEqual(['Bearer mk_pub_x']);
    await expect(feedback.vote('p1')).rejects.toThrow('session expired');
    expect(calls).toHaveLength(1);
  });

  it('posts an idea, comments and follows as the signed-in end user', async () => {
    const { calls, fetchImpl } = fakeFetch(call => {
      if (call.url.endsWith('/boards/ideas/posts')) {
        return Response.json({ post: { id: 'p9', title: 'Dark mode' } }, { status: 201 });
      }
      if (call.url.endsWith('/comments')) {
        return Response.json({ comment: { id: 'c1', isMine: true } }, { status: 201 });
      }
      return Response.json({ subscribed: call.method === 'POST' });
    });
    const feedback = new FeedbackClient({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      endUserToken: () => 'jwt',
    });

    expect(await feedback.board('ideas').createPost({ title: 'Dark mode', body: 'Please' })).toEqual({
      id: 'p9',
      title: 'Dark mode',
    });
    expect(await feedback.comment('p9', 'Me too')).toEqual({ id: 'c1', isMine: true });
    expect(await feedback.follow('p9')).toEqual({ subscribed: true });
    expect(await feedback.unfollow('p9')).toEqual({ subscribed: false });

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      `POST ${BASE}/feedback/boards/ideas/posts`,
      `POST ${BASE}/feedback/posts/p9/comments`,
      `POST ${BASE}/feedback/posts/p9/subscription`,
      `DELETE ${BASE}/feedback/posts/p9/subscription`,
    ]);
    expect(calls.map(call => call.body)).toEqual([
      { title: 'Dark mode', body: 'Please' },
      { body: 'Me too' },
      undefined,
      undefined,
    ]);
    expect(calls.every(call => call.headers.get('authorization') === 'Bearer jwt')).toBe(true);
  });

  it('reads comments as the viewer when signed in', async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ comments: [], nextOffset: null }));
    const feedback = new FeedbackClient({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      endUserToken: () => 'jwt',
    });

    expect(await feedback.comments('p9', { limit: 10 })).toEqual({ comments: [], nextOffset: null });
    expect(calls[0]?.url).toBe(`${BASE}/feedback/posts/p9/comments?limit=10`);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer jwt');
  });

  it('refuses to post, comment or follow without an end user, before any request', async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({}));
    const feedback = new FeedbackClient({ publishableKey: 'mk_pub_x', baseUrl: BASE, fetch: fetchImpl });

    await expect(feedback.board('ideas').createPost({ title: 'x' })).rejects.toMatchObject({
      code: 'missing_end_user_token',
    });
    await expect(feedback.comment('p1', 'x')).rejects.toMatchObject({ code: 'missing_end_user_token' });
    await expect(feedback.follow('p1')).rejects.toMatchObject({ code: 'missing_end_user_token' });
    expect(calls).toHaveLength(0);
  });
});
