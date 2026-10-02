import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessengerClient, messengerConversationIdOf } from './messenger';

import type { MessengerStorage } from './messenger';
import type { MessengerConversation, MessengerMessage } from './wire';

const KEY = 'mk_pub_0123456789abcdefghijklmnopqrstuv';
const identity = { userId: 'u1', userHash: 'a'.repeat(64), name: 'Minji' };

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A fake /v1/messenger: one user, in memory, with a switch to fail the network once. */
function fakeMessenger() {
  const calls: { method: string; path: string; auth: string | null; body: Record<string, unknown> | null }[] = [];
  const conversations: MessengerConversation[] = [];
  const messages = new Map<string, MessengerMessage[]>();
  const seenClientIds = new Set<string>();
  const state = { sessions: 0, revoked: new Set<string>(), failNextNetwork: false };
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === 'storage.test') {
      calls.push({ method: init?.method ?? 'GET', path: url.pathname, auth: null, body: null });
      return new Response(null, { status: 200 });
    }
    const path = url.pathname.replace('/v1/messenger', '');
    const auth = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? null;
    const body = init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>);
    calls.push({ method: init?.method ?? 'GET', path: path + url.search, auth, body });
    if (state.failNextNetwork) {
      state.failNextNetwork = false;
      throw new TypeError('Network request failed');
    }
    if (path === '/sessions') {
      state.sessions += 1;
      return json(
        {
          sessionToken: `mms_${state.sessions}`,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          contactId: 'c1',
          categories: [{ key: 'bug', label: 'Bug report' }],
        },
        201,
      );
    }
    if (auth === null || !auth.startsWith('mms_') || state.revoked.has(auth)) {
      return json({ type: 'https://mocco.dev/problems/invalid_session' }, 401);
    }
    if (path === '/attachments') {
      return json(
        {
          attachmentId: 'att-1',
          upload: { url: 'https://storage.test/put/att-1', method: 'PUT', headers: { 'content-type': 'image/png' } },
        },
        201,
      );
    }
    if (path === '/conversations' && init?.method === 'POST') {
      const id = `conv-${conversations.length + 1}`;
      seenClientIds.add(String(body?.clientMessageId));
      conversations.unshift({
        id,
        status: 'open',
        category: (body?.category as string | undefined) ?? null,
        preview: String(body?.body),
        lastMessageSeq: 1,
        lastMessageAt: new Date().toISOString(),
        hasUnread: false,
        createdAt: new Date().toISOString(),
      });
      messages.set(id, [
        {
          id: 'm1',
          seq: 1,
          author: 'contact',
          authorName: null,
          body: String(body?.body),
          attachments: [],
          createdAt: '',
        },
      ]);
      return json({ conversation: conversations[0] }, 201);
    }
    if (path === '/conversations') {
      return json({ conversations });
    }
    const match = /^\/conversations\/([^/]+)\/(messages|read)$/u.exec(path);
    const thread = messages.get(match?.[1] ?? '') ?? [];
    if (match?.[2] === 'messages' && init?.method === 'POST') {
      const message: MessengerMessage = {
        id: `m${thread.length + 1}`,
        seq: thread.length + 1,
        author: 'contact',
        authorName: null,
        body: String(body?.body),
        attachments: [],
        createdAt: '',
      };
      thread.push(message);
      return json({ message }, 201);
    }
    if (match?.[2] === 'messages') {
      const afterSeq = Number(url.searchParams.get('afterSeq') ?? 0);
      return json({ messages: thread.filter(message => message.seq > afterSeq) });
    }
    return new Response(null, { status: 204 });
  });
  /** The team replies in a conversation. */
  const reply = (conversationId: string, body: string) => {
    const thread = messages.get(conversationId) ?? [];
    thread.push({
      id: `m${thread.length + 1}`,
      seq: thread.length + 1,
      author: 'operator',
      authorName: 'Ada',
      body,
      attachments: [],
      createdAt: '',
    });
    const conversation = conversations.find(entry => entry.id === conversationId);
    if (conversation !== undefined) {
      conversation.hasUnread = true;
      conversation.lastMessageSeq = thread.length;
      conversation.preview = body;
    }
  };
  return { calls, state, fetch: fetchSpy, reply, seenClientIds };
}

function memoryStorage(): MessengerStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: key => {
      items.delete(key);
    },
  };
}

const clientFor = (
  server: ReturnType<typeof fakeMessenger>,
  extra: Partial<ConstructorParameters<typeof MessengerClient>[0]> = {},
) =>
  new MessengerClient({
    publishableKey: KEY,
    baseUrl: 'https://mocco.test/v1',
    identity: async () => await Promise.resolve(identity),
    context: () => ({ appVersion: '3.8.0', platform: 'ios' }),
    fetch: server.fetch,
    ...extra,
  });

describe('MessengerClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a session with the signed identity, then lists, starts and continues conversations', async () => {
    const server = fakeMessenger();
    const client = clientFor(server);

    await client.refresh();
    const conversation = await client.startConversation({ category: 'bug', body: 'The widget is stuck' });
    await client.sendMessage(conversation.id, 'Still stuck after updating');
    const thread = await client.loadThread(conversation.id);

    expect(server.calls[0]).toMatchObject({
      method: 'POST',
      path: '/sessions',
      auth: KEY,
      body: { ...identity, context: { appVersion: '3.8.0', platform: 'ios' } },
    });
    expect(server.calls.slice(1).every(call => call.auth === 'mms_1')).toBe(true);
    expect(client.getState()).toMatchObject({ status: 'ready', categories: [{ key: 'bug', label: 'Bug report' }] });
    expect(thread.map(message => message.body)).toEqual(['The widget is stuck', 'Still stuck after updating']);
    const started = server.calls.find(call => call.path === '/conversations' && call.method === 'POST');
    expect(started?.body).toMatchObject({
      category: 'bug',
      clientMessageId: expect.any(String),
      context: { platform: 'ios' },
    });
  });

  it('counts unread replies, fetches only new messages, and clears unread on read', async () => {
    const server = fakeMessenger();
    const client = clientFor(server);
    const conversation = await client.startConversation({ body: 'Hello' });
    await client.loadThread(conversation.id);
    server.reply(conversation.id, 'Hi! How can we help?');

    await client.refresh();
    expect(client.getState().unreadCount).toBe(1);
    await client.loadThread(conversation.id);
    await client.markRead(conversation.id);

    expect(server.calls.filter(call => call.path.includes('/messages?')).map(call => call.path)).toEqual([
      `/conversations/${conversation.id}/messages?afterSeq=0`,
      `/conversations/${conversation.id}/messages?afterSeq=1`,
    ]);
    expect(server.calls.at(-1)).toMatchObject({ path: `/conversations/${conversation.id}/read`, body: { seq: 2 } });
    expect(client.getState().unreadCount).toBe(0);
    expect(client.getState().threads[conversation.id]?.map(message => message.author)).toEqual(['contact', 'operator']);
  });

  it('keeps the session across launches, and reopens one the server no longer accepts', async () => {
    const server = fakeMessenger();
    const storage = memoryStorage();
    await clientFor(server, { storage }).refresh();
    expect(server.state.sessions).toBe(1);

    await clientFor(server, { storage }).refresh();
    expect(server.state.sessions).toBe(1);

    server.state.revoked.add('mms_1');
    const relaunched = clientFor(server, { storage });
    await relaunched.refresh();
    expect(server.state.sessions).toBe(2);
    expect(relaunched.getState().status).toBe('ready');
    expect(JSON.parse(storage.items.values().next().value ?? '{}')).toMatchObject({ token: 'mms_2', userId: 'u1' });
  });

  it('retries a send once on a network failure with the same client message id', async () => {
    const server = fakeMessenger();
    const client = clientFor(server);
    await client.refresh();
    server.state.failNextNetwork = true;

    await client.startConversation({ body: 'Hello' });
    const starts = server.calls.filter(call => call.path === '/conversations' && call.method === 'POST');

    expect(starts).toHaveLength(2);
    expect(starts[0]?.body?.clientMessageId).toBe(starts[1]?.body?.clientMessageId);
  });

  it('is signed out while the app has no user, and forgets the session on sign out', async () => {
    const server = fakeMessenger();
    const storage = memoryStorage();
    const user: { current: typeof identity | null } = { current: null };
    const client = clientFor(server, { storage, identity: async () => await Promise.resolve(user.current) });

    await client.refresh();
    expect(client.getState().status).toBe('signed_out');
    expect(server.calls).toEqual([]);

    user.current = identity;
    await client.refresh();
    expect(client.getState().status).toBe('ready');
    await client.signOut();
    expect(client.getState().status).toBe('signed_out');
    expect(storage.items.size).toBe(0);
  });

  it('polls while watched, pauses in the background, and stops when nothing is watched', async () => {
    vi.useFakeTimers();
    const server = fakeMessenger();
    const client = clientFor(server, { pollIntervalMs: 5000 });
    const listener = vi.fn();
    client.subscribe(listener);

    const stop = client.watch();
    await vi.advanceTimersByTimeAsync(10_000);
    const whileWatched = server.calls.filter(call => call.path === '/conversations').length;
    client.setActive(false);
    await vi.advanceTimersByTimeAsync(20_000);
    const whilePaused = server.calls.filter(call => call.path === '/conversations').length;
    client.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    const afterStop = server.calls.filter(call => call.path === '/conversations').length;

    expect(whileWatched).toBe(3);
    expect(whilePaused).toBe(whileWatched);
    expect(afterStop).toBe(whilePaused + 1);
    expect(listener).toHaveBeenCalled();
  });

  it('uploads an attachment to the URL Mocco hands out, then sends its id', async () => {
    const server = fakeMessenger();
    const client = clientFor(server);
    const conversation = await client.startConversation({ body: 'Hello' });

    const attachmentId = await client.attach({
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
      sizeBytes: 3,
    });
    await client.sendMessage(conversation.id, 'See this', [attachmentId]);

    expect(server.calls.find(call => call.path === '/attachments')?.body).toEqual({
      contentType: 'image/png',
      sizeBytes: 3,
    });
    expect(server.calls.find(call => call.path === '/put/att-1')).toMatchObject({ method: 'PUT', auth: null });
    expect(server.calls.find(call => call.path.endsWith('/messages') && call.method === 'POST')?.body).toMatchObject({
      body: 'See this',
      attachmentIds: ['att-1'],
    });
  });

  it('registers the push token, drops it on sign out, and reads conversation ids from pushes', async () => {
    const server = fakeMessenger();
    const client = clientFor(server);
    await client.registerPushToken({ provider: 'expo', token: 'ExponentPushToken[abc]', platform: 'ios' });
    await client.signOut();

    expect(server.calls.filter(call => call.path === '/push-tokens').map(call => [call.method, call.body])).toEqual([
      ['POST', { provider: 'expo', token: 'ExponentPushToken[abc]', platform: 'ios' }],
      ['DELETE', { token: 'ExponentPushToken[abc]' }],
    ]);
    expect(messengerConversationIdOf({ mocco: 'messenger', conversationId: 'c1' })).toBe('c1');
    expect(messengerConversationIdOf({ type: 'promo' })).toBeUndefined();
    expect(messengerConversationIdOf(null)).toBeUndefined();
  });

  it('refuses a secret key', () => {
    expect(
      () =>
        new MessengerClient({
          publishableKey: 'mk_sec_0123456789abcdefghijklmnopqrstuv',
          identity: async () => await Promise.resolve(null),
        }),
    ).toThrow(/publishable key/u);
  });
});
