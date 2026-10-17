import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeedbackSheetModel } from './feedback-sheet';

import type { FeedbackPost } from './feedback';

const BASE = 'https://mocco.test/v1';

const postOf = (number: number, title: string, voteCount: number): FeedbackPost => ({
  id: `p${number}`,
  number,
  title,
  body: '',
  status: 'under_review',
  categoryId: null,
  voteCount,
  commentCount: 0,
  createdAt: '2026-10-17T10:00:00.000Z',
  shippedAt: null,
  mergedIntoPostId: null,
});

/** A fetch for one board with two posts; votes count, and a new post gets id p9. */
function boardFetch(opts: { failSimilar?: boolean; failPost?: boolean } = {}) {
  const requests: string[] = [];
  const counts: Record<string, number> = { p1: 5, p2: 2 };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname.replace('/v1/feedback', '');
    const query = new URL(url).searchParams.get('q');
    const suffix = query === null ? '' : `?q=${query}`;
    requests.push(`${method} ${path}${suffix}`);
    const vote = /^\/posts\/(p\d)\/vote$/.exec(path);
    if (vote !== null) {
      const id = vote[1] ?? '';
      counts[id] = (counts[id] ?? 0) + (method === 'POST' ? 1 : -1);
      return await Promise.resolve(
        Response.json({ vote: method === 'POST' ? 'counted' : null, voteCount: counts[id] }),
      );
    }
    if (path === '/boards/ideas') {
      return await Promise.resolve(Response.json({ board: { slug: 'ideas', name: 'Ideas', categories: [] } }));
    }
    if (path === '/boards/ideas/similar') {
      return opts.failSimilar === true
        ? await Promise.resolve(Response.json({ title: 'down' }, { status: 503 }))
        : await Promise.resolve(Response.json({ posts: [postOf(1, `Like ${query ?? ''}`, counts.p1 ?? 0)] }));
    }
    if (path === '/boards/ideas/posts' && method === 'POST') {
      if (opts.failPost === true) {
        return await Promise.resolve(
          Response.json({ type: 'https://mocco.dev/problems/rate_limited', title: 'Slow down' }, { status: 429 }),
        );
      }
      const input = JSON.parse(String(init.body)) as { title: string };
      return await Promise.resolve(Response.json({ post: postOf(9, input.title, 1) }, { status: 201 }));
    }
    return await Promise.resolve(
      Response.json({ posts: [postOf(1, 'Dark mode', counts.p1 ?? 0), postOf(2, 'Export', 2)], nextOffset: null }),
    );
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

const sheetWith = (fetchImpl: typeof fetch, token: string | null = 'jwt') =>
  new FeedbackSheetModel({
    publishableKey: 'mk_pub_x',
    baseUrl: BASE,
    fetch: fetchImpl,
    board: 'ideas',
    endUserToken: () => token,
    similarDelayMs: 300,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe('FeedbackSheetModel', () => {
  it('loads the board and its top posts, and whether a user is signed in', async () => {
    const { requests, fetchImpl } = boardFetch();
    const sheet = sheetWith(fetchImpl);
    const seen: string[] = [];
    sheet.subscribe(() => {
      seen.push(sheet.getState().status);
    });

    await sheet.load();

    const state = sheet.getState();
    expect(state.status).toBe('ready');
    expect(state.board?.name).toBe('Ideas');
    expect(state.posts.map(post => post.title)).toEqual(['Dark mode', 'Export']);
    expect(state.isSignedIn).toBe(true);
    expect(seen).toEqual(['loading', 'ready']);
    expect(requests).toEqual(['GET /boards/ideas', 'GET /boards/ideas/posts']);
  });

  it('is read-only without a signed-in user', async () => {
    const { fetchImpl } = boardFetch();
    const sheet = sheetWith(fetchImpl, null);

    await sheet.load();
    await sheet.toggleVote('p1');

    expect(sheet.getState().isSignedIn).toBe(false);
    expect(sheet.getState().actionError).toMatchObject({ code: 'missing_end_user_token' });
    expect(sheet.getState().posts[0]?.voteCount).toBe(5);
  });

  it('votes, then takes the vote back, keeping the count from the answers', async () => {
    const { requests, fetchImpl } = boardFetch();
    const sheet = sheetWith(fetchImpl);
    await sheet.load();

    await sheet.toggleVote('p2');
    expect(sheet.getState().votes.p2).toBe('counted');
    expect(sheet.getState().posts[1]?.voteCount).toBe(3);

    await sheet.toggleVote('p2');
    expect(sheet.getState().votes.p2).toBeNull();
    expect(sheet.getState().posts[1]?.voteCount).toBe(2);
    expect(sheet.getState().voting).toEqual([]);
    expect(requests.slice(2)).toEqual(['POST /posts/p2/vote', 'DELETE /posts/p2/vote']);
  });

  it('ignores a second tap while the first vote is on its way', async () => {
    const { requests, fetchImpl } = boardFetch();
    const sheet = sheetWith(fetchImpl);
    await sheet.load();

    await Promise.all([sheet.toggleVote('p1'), sheet.toggleVote('p1')]);

    expect(requests.filter(request => /\/vote$/.test(request))).toEqual(['POST /posts/p1/vote']);
  });

  it('searches similar posts once typing pauses, and only for the latest title', async () => {
    vi.useFakeTimers();
    const { requests, fetchImpl } = boardFetch();
    const sheet = sheetWith(fetchImpl);

    sheet.setDraft({ title: 'Da' });
    expect(sheet.getState().draft.isSearching).toBe(false);
    sheet.setDraft({ title: 'Dark' });
    sheet.setDraft({ title: 'Dark them' });
    expect(sheet.getState().draft.isSearching).toBe(true);
    await vi.advanceTimersByTimeAsync(300);

    expect(requests).toEqual(['GET /boards/ideas/similar?q=Dark them']);
    expect(sheet.getState().draft.similar.map(post => post.title)).toEqual(['Like Dark them']);
    expect(sheet.getState().draft.isSearching).toBe(false);

    // A short title clears the suggestions without searching.
    sheet.setDraft({ title: 'D' });
    await vi.advanceTimersByTimeAsync(300);
    expect(sheet.getState().draft.similar).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('keeps the last suggestions when a search fails', async () => {
    vi.useFakeTimers();
    const { fetchImpl } = boardFetch({ failSimilar: true });
    const sheet = sheetWith(fetchImpl);

    sheet.setDraft({ title: 'Dark mode' });
    // Past the search's delay and the client's retries.
    await vi.runAllTimersAsync();

    expect(sheet.getState().draft).toMatchObject({ similar: [], isSearching: false });
    expect(sheet.getState().actionError).toBeNull();
  });

  it('a vote on a suggestion updates its count there too', async () => {
    vi.useFakeTimers();
    const { fetchImpl } = boardFetch();
    const sheet = sheetWith(fetchImpl);
    await sheet.load();
    sheet.setDraft({ title: 'Dark mode please' });
    await vi.advanceTimersByTimeAsync(300);

    await sheet.toggleVote('p1');

    expect(sheet.getState().draft.similar[0]?.voteCount).toBe(6);
    expect(sheet.getState().posts[0]?.voteCount).toBe(6);
  });

  it('posts the draft: it goes to the top with the author vote, and the draft clears', async () => {
    const { requests, fetchImpl } = boardFetch();
    const sheet = sheetWith(fetchImpl);
    await sheet.load();
    sheet.setDraft({ title: '  Offline mode ', body: ' ' });

    const post = await sheet.submit();

    expect(post?.title).toBe('Offline mode');
    const state = sheet.getState();
    expect(state.posts.map(each => each.id)).toEqual(['p9', 'p1', 'p2']);
    expect(state.votes.p9).toBe('counted');
    expect(state.draft).toEqual({ title: '', body: '', similar: [], isSearching: false });
    expect(state.posted?.id).toBe('p9');
    expect(requests.at(-1)).toBe('POST /boards/ideas/posts');

    // Writing another idea forgets the confirmation.
    sheet.setDraft({ title: 'Another' });
    expect(sheet.getState().posted).toBeNull();
  });

  it('sends nothing for an empty title, and keeps the draft when posting fails', async () => {
    const { requests, fetchImpl } = boardFetch({ failPost: true });
    const sheet = sheetWith(fetchImpl);

    expect(await sheet.submit()).toBeNull();
    expect(requests).toEqual([]);

    sheet.setDraft({ title: 'Offline mode' });
    expect(await sheet.submit()).toBeNull();
    expect(sheet.getState().draft.title).toBe('Offline mode');
    expect(sheet.getState().isPosting).toBe(false);
    expect(sheet.getState().actionError).toMatchObject({ status: 429 });
  });

  it('lands a failed load in error', async () => {
    const fetchImpl = (async () =>
      await Promise.resolve(Response.json({ title: 'Not found' }, { status: 404 }))) as unknown as typeof fetch;
    const sheet = sheetWith(fetchImpl);

    await sheet.load();

    expect(sheet.getState().status).toBe('error');
    expect(sheet.getState().error).toMatchObject({ status: 404 });
  });
});
