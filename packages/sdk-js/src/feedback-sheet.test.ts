// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeedbackSheet } from './feedback-sheet';

const BASE = 'https://mocco.test/v1';

const postOf = (number: number, title: string, voteCount: number) => ({
  id: `p${number}`,
  number,
  title,
  body: '',
  status: number === 1 ? 'planned' : 'under_review',
  categoryId: null,
  voteCount,
  commentCount: 0,
  createdAt: '2026-10-17T10:00:00.000Z',
  shippedAt: null,
  mergedIntoPostId: null,
});

/**
 * A fetch for one board with two posts (one titled with markup, which must stay text). Signed in,
 * the list says the user voted for the posts in `voted` earlier.
 */
function boardFetch(opts: { voted?: string[] } = {}) {
  const requests: { method: string; url: string; body: unknown }[] = [];
  let votes = 5;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    requests.push({ method, url, body });
    const { pathname } = new URL(url);
    if (pathname.endsWith('/posts/p1/vote')) {
      votes += method === 'POST' ? 1 : -1;
      return await Promise.resolve(Response.json({ vote: method === 'POST' ? 'counted' : null, voteCount: votes }));
    }
    if (pathname.endsWith('/posts/p2/vote')) {
      return await Promise.resolve(Response.json({ vote: method === 'POST' ? 'counted' : null, voteCount: 1 }));
    }
    if (pathname.endsWith('/boards/ideas')) {
      return await Promise.resolve(Response.json({ board: { slug: 'ideas', name: 'Ideas', categories: [] } }));
    }
    if (pathname.endsWith('/similar')) {
      return await Promise.resolve(Response.json({ posts: [postOf(1, 'Dark mode', votes)] }));
    }
    if (method === 'POST') {
      return await Promise.resolve(Response.json({ post: postOf(9, 'Offline mode', 1) }, { status: 201 }));
    }
    const isSignedIn = new Headers(init.headers).get('authorization') === 'Bearer jwt';
    const listed = (post: ReturnType<typeof postOf>) =>
      isSignedIn ? { ...post, viewerVote: opts.voted?.includes(post.id) === true ? 'counted' : null } : post;
    return await Promise.resolve(
      Response.json({
        posts: [listed(postOf(1, 'Dark mode', votes)), listed(postOf(2, '<img src=x onerror="alert(1)">', 2))],
        nextOffset: null,
      }),
    );
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

function button(): HTMLButtonElement {
  const node = document.createElement('button');
  node.id = 'ideas';
  node.textContent = 'Ideas';
  document.body.append(node);
  return node;
}

const sheetWith = (fetchImpl: typeof fetch, token: string | null) =>
  createFeedbackSheet({
    publishableKey: 'mk_pub_x',
    baseUrl: BASE,
    fetch: fetchImpl,
    board: 'ideas',
    endUserToken: () => token,
    similarDelayMs: 10,
  });

const panel = () => document.querySelector<HTMLElement>('[role="dialog"]');
const voteButtons = () => [...(panel()?.querySelectorAll<HTMLButtonElement>('.mocco-fs-vote') ?? [])];

afterEach(() => {
  document.body.replaceChildren();
});

describe('@mocco/js/feedback-sheet', () => {
  it('opens a sheet with the top ideas, and votes and unvotes from it', async () => {
    const target = button();
    const { requests, fetchImpl } = boardFetch();
    const onOpenChange = vi.fn();
    sheetWith(fetchImpl, 'jwt').mount('#ideas', { onOpenChange });

    target.click();

    expect(target.getAttribute('aria-expanded')).toBe('true');
    expect(onOpenChange).toHaveBeenCalledWith(true);
    await vi.waitFor(() => {
      expect(panel()?.querySelectorAll('li')).toHaveLength(2);
    });
    expect(panel()?.querySelector('h2')?.textContent).toBe('Ideas');
    expect(panel()?.querySelector('li')?.textContent).toBe('5Vote (5 votes)Dark modePlanned');
    // A user's title is shown as text: nothing in it becomes an element.
    expect(panel()?.querySelector('img')).toBeNull();
    expect(panel()?.querySelectorAll('li')[1]?.textContent).toContain('<img src=x onerror="alert(1)">');

    voteButtons()[0]?.click();
    await vi.waitFor(() => {
      expect(voteButtons()[0]?.getAttribute('aria-pressed')).toBe('true');
    });
    expect(voteButtons()[0]?.textContent).toBe('6Voted (6 votes)');

    voteButtons()[0]?.click();
    await vi.waitFor(() => {
      expect(voteButtons()[0]?.getAttribute('aria-pressed')).toBe('false');
    });
    expect(requests.filter(request => request.url.endsWith('/vote')).map(request => request.method)).toEqual([
      'POST',
      'DELETE',
    ]);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel()).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('shows "Voted" on opening for an idea the user voted for before', async () => {
    const target = button();
    const { requests, fetchImpl } = boardFetch({ voted: ['p2'] });
    sheetWith(fetchImpl, 'jwt').mount(target);

    target.click();

    await vi.waitFor(() => {
      expect(panel()?.querySelectorAll('li')).toHaveLength(2);
    });
    expect(voteButtons().map(vote => vote.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(voteButtons()[1]?.textContent).toBe('2Voted (2 votes)');
    voteButtons()[1]?.click();
    await vi.waitFor(() => {
      expect(voteButtons()[1]?.getAttribute('aria-pressed')).toBe('false');
    });
    expect(requests.at(-1)?.method).toBe('DELETE');
  });

  it('suggests similar ideas while a title is typed, and posts one', async () => {
    const target = button();
    const { requests, fetchImpl } = boardFetch();
    sheetWith(fetchImpl, 'jwt').mount(target, { categoryId: '00000000-0000-4000-8000-000000000001' });
    target.click();
    await vi.waitFor(() => {
      expect(panel()?.querySelectorAll('li')).toHaveLength(2);
    });
    const title = panel()?.querySelector('input');
    const submit = panel()?.querySelector<HTMLButtonElement>('.mocco-fs-submit');
    expect(submit?.disabled).toBe(true);

    if (title === null || title === undefined) {
      throw new Error('no title input');
    }
    title.value = 'Dark theme';
    title.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      expect(panel()?.querySelector('form')?.querySelector(':scope ul')?.children).toHaveLength(1);
    });
    expect(panel()?.querySelector('form')?.querySelector<HTMLElement>(':scope h3')?.hidden).toBe(false);
    expect(panel()?.querySelector('textarea')?.hidden).toBe(false);
    expect(submit?.disabled).toBe(false);

    submit?.click();
    await vi.waitFor(() => {
      expect(panel()?.querySelector('[aria-live]')?.textContent).toBe('Thanks! Your idea is posted.');
    });
    const created = requests.find(request => request.method === 'POST');
    expect(created?.url).toBe(`${BASE}/feedback/boards/ideas/posts`);
    expect(created?.body).toEqual({ title: 'Dark theme', categoryId: '00000000-0000-4000-8000-000000000001' });
    expect(title.value).toBe('');
    expect(panel()?.querySelector('li')?.textContent).toContain('Offline mode');
  });

  it('is read-only for a visitor', async () => {
    const target = button();
    const { fetchImpl } = boardFetch();
    sheetWith(fetchImpl, null).mount(target);

    target.click();

    await vi.waitFor(() => {
      expect(panel()?.querySelectorAll('li')).toHaveLength(2);
    });
    expect(panel()?.querySelector('form')?.hidden).toBe(true);
    expect(panel()?.querySelector<HTMLElement>('.mocco-fs-note')?.hidden).toBe(false);
    expect(voteButtons().every(vote => vote.disabled)).toBe(true);
  });

  it('removes everything on unmount', () => {
    const target = button();
    const { fetchImpl } = boardFetch();
    const unmount = sheetWith(fetchImpl, null).mount(target, { labels: { title: 'Ideas for Acme' } });

    target.click();
    expect(panel()?.querySelector('h2')?.textContent).toBe('Ideas for Acme');
    unmount();

    expect(panel()).toBeNull();
    expect(target.hasAttribute('aria-expanded')).toBe(false);
    target.click();
    expect(panel()).toBeNull();
  });
});
