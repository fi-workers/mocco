import { describe, expect, it, vi } from 'vitest';

import { MoccoError } from './errors';
import { WhatsNew } from './whats-new';

import type { FeedbackChangelogEntry } from './feedback';

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

const entry = (id: string, publishedAt: string): FeedbackChangelogEntry => ({
  id,
  slug: id,
  title: `Entry ${id}`,
  body: 'Shipped.',
  tags: ['new'],
  publishedAt,
  posts: [],
});

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    storage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    },
  };
}

describe('WhatsNew', () => {
  it('counts unread for a visitor since the cursor this device keeps', async () => {
    const { items, storage } = memoryStorage();
    const { calls, fetchImpl } = fakeFetch(call => {
      if (call.url.includes('/changelog/unread')) {
        return Response.json({ count: 2, lastSeenAt: null });
      }
      return Response.json({ entries: [entry('b', '2026-10-17T10:00:00.000Z')], nextOffset: null });
    });
    const whatsNew = new WhatsNew({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      board: 'ideas',
      storage,
    });
    const changes = vi.fn();
    whatsNew.subscribe(changes);

    expect(await whatsNew.unreadCount()).toBe(2);
    expect(whatsNew.getState()).toMatchObject({ status: 'ready', unreadCount: 2 });
    expect(calls[0]?.url).toBe(`${BASE}/feedback/boards/ideas/changelog/unread`);

    // Marking seen keeps the newest entry's date (not the device's clock), sends no write.
    await whatsNew.markSeen();
    expect(whatsNew.getState()).toMatchObject({ unreadCount: 0, lastSeenAt: '2026-10-17T10:00:00.000Z' });
    expect(items.get('mocco-whats-new:v1:mk_pub_x:ideas')).toBe('2026-10-17T10:00:00.000Z');
    expect(calls.map(call => call.method)).toEqual(['GET', 'GET']);

    await whatsNew.unreadCount();
    expect(new URL(calls[2]?.url ?? '').searchParams.get('since')).toBe('2026-10-17T10:00:00.000Z');
    expect(changes).toHaveBeenCalled();
  });

  it('marks a signed-in user seen on Mocco, using the loaded entries', async () => {
    const { calls, fetchImpl } = fakeFetch(call => {
      if (call.url.endsWith('/changelog/seen')) {
        return Response.json({ lastSeenAt: '2026-10-17T12:00:00.000Z' });
      }
      if (call.url.includes('/changelog/unread')) {
        return Response.json({ count: 1, lastSeenAt: '2026-10-01T00:00:00.000Z' });
      }
      return Response.json({ entries: [entry('a', '2026-10-17T11:00:00.000Z')], nextOffset: null });
    });
    const whatsNew = new WhatsNew({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      board: 'ideas',
      pageSize: 5,
      endUserToken: () => 'jwt',
    });

    await whatsNew.unreadCount();
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer jwt');
    expect(await whatsNew.loadEntries()).toHaveLength(1);
    await whatsNew.markSeen();

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      `GET ${BASE}/feedback/boards/ideas/changelog/unread`,
      `GET ${BASE}/feedback/boards/ideas/changelog?limit=5`,
      `POST ${BASE}/feedback/boards/ideas/changelog/seen`,
    ]);
    expect(calls[2]?.headers.get('x-mocco-key')).toBe('mk_pub_x');
    expect(whatsNew.getState()).toMatchObject({ unreadCount: 0, lastSeenAt: '2026-10-17T12:00:00.000Z' });
  });

  it('keeps the last count and reports the error when a refresh fails', async () => {
    let isUp = true;
    const { fetchImpl } = fakeFetch(() =>
      isUp ? Response.json({ count: 4, lastSeenAt: null }) : problem(404, 'not_found'),
    );
    const whatsNew = new WhatsNew({ publishableKey: 'mk_pub_x', baseUrl: BASE, fetch: fetchImpl, board: 'ideas' });

    await whatsNew.refresh();
    isUp = false;
    await whatsNew.refresh();

    expect(whatsNew.getState()).toMatchObject({ status: 'error', unreadCount: 4 });
    expect(whatsNew.getState().error).toBeInstanceOf(MoccoError);
  });

  it('keeps the cursor in memory when storage fails', async () => {
    const { calls, fetchImpl } = fakeFetch(call =>
      call.url.includes('/unread')
        ? Response.json({ count: 0, lastSeenAt: null })
        : Response.json({ entries: [entry('a', '2026-10-17T11:00:00.000Z')], nextOffset: null }),
    );
    const whatsNew = new WhatsNew({
      publishableKey: 'mk_pub_x',
      baseUrl: BASE,
      fetch: fetchImpl,
      board: 'ideas',
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });

    await whatsNew.markSeen();
    await whatsNew.unreadCount();

    expect(new URL(calls.at(-1)?.url ?? '').searchParams.get('since')).toBe('2026-10-17T11:00:00.000Z');
  });
});
