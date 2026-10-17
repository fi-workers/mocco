// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeedback } from './feedback';
import { createWhatsNew, excerptOf } from './whats-new';

const BASE = 'https://mocco.test/v1';
const storage = () =>
  Reflect.get(globalThis, 'localStorage') as { length: number; getItem(key: string): string | null; clear(): void };

const entries = [
  {
    id: 'e2',
    slug: 'dark-mode',
    title: 'Dark mode',
    body: '## Dark mode\n\nFollow the **system** setting. [Read more](https://acme.test/dark)\n<img src=x onerror="alert(1)">',
    tags: ['new'],
    publishedAt: '2026-10-17T10:00:00.000Z',
    posts: [],
  },
  {
    id: 'e1',
    slug: 'faster-sync',
    title: 'Faster sync',
    body: 'Sync is faster.',
    tags: ['improved'],
    publishedAt: '2026-10-10T10:00:00.000Z',
    posts: [],
  },
];

/** A fetch for one board: `unread` entries are new until marked seen. */
function boardFetch(unread: number) {
  const urls: string[] = [];
  let count = unread;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(`${init.method ?? 'GET'} ${url}`);
    // eslint-disable-next-line sonarjs/null-dereference -- url is a string, never null
    if (url.includes('/changelog/seen')) {
      count = 0;
      return await Promise.resolve(Response.json({ lastSeenAt: '2026-10-17T12:00:00.000Z' }));
    }
    if (url.includes('/changelog/unread')) {
      const since = new URL(url).searchParams.get('since');
      return await Promise.resolve(Response.json({ count: since === null ? count : 0, lastSeenAt: since }));
    }
    return await Promise.resolve(Response.json({ entries, nextOffset: null }));
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

function button(): HTMLButtonElement {
  const node = document.createElement('button');
  node.id = 'whats-new';
  node.textContent = "What's new";
  document.body.append(node);
  return node;
}

afterEach(() => {
  document.body.replaceChildren();
  storage().clear();
});

describe('@mocco/js/whats-new', () => {
  it('shows the unread count on the button, and the entries when it is clicked', async () => {
    const target = button();
    const { urls, fetchImpl } = boardFetch(2);
    const whatsNew = createWhatsNew({ publishableKey: 'mk_pub_x', baseUrl: BASE, fetch: fetchImpl, board: 'ideas' });
    const onOpenChange = vi.fn();

    whatsNew.mount('#whats-new', { onOpenChange, moreUrl: 'https://help.acme.test/feedback/ideas/changelog' });

    const badge = target.querySelector<HTMLElement>('.mocco-wn-badge');
    await vi.waitFor(() => {
      expect(badge?.hidden).toBe(false);
    });
    expect(badge?.textContent).toBe('2 (2 unread updates)');
    expect(target.getAttribute('aria-expanded')).toBe('false');

    target.click();

    const panel = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(panel?.getAttribute('aria-label')).toBe("What's new");
    expect(target.getAttribute('aria-expanded')).toBe('true');
    expect(onOpenChange).toHaveBeenCalledWith(true);
    await vi.waitFor(() => {
      expect(panel?.querySelectorAll('li')).toHaveLength(2);
    });
    expect(panel?.querySelector('h3')?.textContent).toBe('Dark mode');
    expect(panel?.querySelector('a')?.getAttribute('href')).toBe('https://help.acme.test/feedback/ideas/changelog');
    // The team's Markdown is shown as text: nothing in it becomes an element.
    expect(panel?.querySelector('img')).toBeNull();

    // Opening marks everything seen: the badge goes away, and the visitor's device keeps the newest date.
    await vi.waitFor(() => {
      expect(badge?.hidden).toBe(true);
    });
    expect(storage().getItem('mocco-whats-new:v1:mk_pub_x:ideas')).toBe('2026-10-17T10:00:00.000Z');
    expect(urls).toEqual([
      `GET ${BASE}/feedback/boards/ideas/changelog/unread`,
      `GET ${BASE}/feedback/boards/ideas/changelog?limit=10`,
    ]);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('marks a signed-in user seen on Mocco', async () => {
    const target = button();
    const { urls, fetchImpl } = boardFetch(1);
    const whatsNew = createWhatsNew({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      board: 'ideas',
      endUserToken: () => 'jwt',
      storage: null,
    });

    expect(await whatsNew.unreadCount()).toBe(1);
    await whatsNew.markSeen();

    expect(urls).toContain(`POST ${BASE}/feedback/boards/ideas/changelog/seen`);
    expect(whatsNew.client.getState().unreadCount).toBe(0);
    expect(storage()).toHaveLength(0);
    expect(target.querySelector('.mocco-wn-badge')).toBeNull();
  });

  it('closes on a click outside and removes everything on unmount', async () => {
    const target = button();
    const { fetchImpl } = boardFetch(0);
    const whatsNew = createWhatsNew({ publishableKey: 'mk_pub_x', baseUrl: BASE, fetch: fetchImpl, board: 'ideas' });
    const unmount = whatsNew.mount(target, { markSeenOnOpen: false, labels: { title: 'Updates' } });

    target.click();
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Updates');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    unmount();
    expect(target.querySelector('.mocco-wn-badge')).toBeNull();
    expect(target.hasAttribute('aria-expanded')).toBe(false);
  });

  it('refuses a selector that matches nothing', () => {
    const { fetchImpl } = boardFetch(0);
    const whatsNew = createWhatsNew({ publishableKey: 'mk_pub_x', baseUrl: BASE, fetch: fetchImpl, board: 'ideas' });
    expect(() => whatsNew.mount('#missing')).toThrow('No element matches #missing');
  });

  it('makes a plain excerpt of an entry', () => {
    expect(excerptOf('# Title\n\n- **Bold** and [a link](https://x.test) ![img](https://x.test/a.png)')).toBe(
      'Title - Bold and a link img',
    );
    expect(excerptOf('```\ncode\n```\ntext')).toBe('code text');
    expect(excerptOf('a'.repeat(300), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});

describe('@mocco/js/feedback', () => {
  it('reads a board with the publishable key', async () => {
    const urls: string[] = [];
    const feedback = createFeedback({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: (async (url: string) => {
        urls.push(url);
        return await Promise.resolve(Response.json({ posts: [], nextOffset: null }));
      }) as unknown as typeof fetch,
    });

    expect(await feedback.board('ideas').posts({ sort: 'top' })).toEqual({ posts: [], nextOffset: null });
    expect(urls).toEqual([`${BASE}/feedback/boards/ideas/posts?sort=top`]);
  });
});
