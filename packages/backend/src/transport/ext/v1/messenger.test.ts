// /v1/messenger (#95) end to end on pglite: sessions for server-signed users, starting
// and continuing conversations, the team's replies, and the isolation between users.
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { MessengerEventTypes } from '@mocco/common/events';
import { MessengerClient } from '@mocco/sdk-core';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createMessengerDomain } from '@backend/domain/messenger/compose';
import { userHashOf } from '@backend/domain/messenger/identity';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { ObjectRepo } from '@backend/domain/storage/repos/object.repo';
import { StorageUrlSigner } from '@backend/domain/storage/signing';
import { StorageService } from '@backend/domain/storage/StorageService';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  messengerAttachments,
  messengerContacts,
  messengerMessages,
  objects,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { MessengerRateLimits } from '@backend/transport/ext/v1/messenger';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { PublishInput } from '@backend/domain/events/EventBus';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { MessengerDomain } from '@backend/domain/messenger/compose';
import type { V1Env } from '@backend/transport/ext/v1/middleware';

const BASE = 'https://www.mocco.test/api/ext/v1/messenger';

const jsonOf = async (response: Response) => (await response.json()) as Record<string, string>;

describe('/v1/messenger (pglite)', () => {
  let t: TestDb;
  let app: Hono<V1Env>;
  let messenger: MessengerDomain;
  let published: PublishInput[];
  let workspaceId: string;
  let projectId: string;
  let operatorId: string;
  let key: string;
  let secret: string;
  let store: FilesystemObjectStore;

  const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
    const response = await app.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          ...(opts.token !== undefined && { authorization: `Bearer ${opts.token}` }),
          'content-type': 'application/json',
        },
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as Record<string, never>) };
  };
  /** A session for `userId`, signed like the app's server would. */
  const sessionFor = async (userId: string, extra: Record<string, unknown> = {}) => {
    const answer = await call('POST', '/sessions', {
      token: key,
      body: { userId, userHash: userHashOf(secret, userId), ...extra },
    });
    expect(answer.status).toBe(201);
    return (answer.body as unknown as { sessionToken: string }).sessionToken;
  };
  const start = async (token: string, body = 'The widget stopped updating', clientMessageId = randomUUID()) =>
    await call('POST', '/conversations', {
      token,
      body: { category: 'bug', body, clientMessageId, context: { appVersion: '3.8.0', build: '412', platform: 'ios' } },
    });

  const guestSession = async (body: Record<string, unknown>, ip = '203.0.113.7') =>
    await app.fetch(
      new Request(`${BASE}/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ guest: true, ...body }),
      }),
    );

  /** The storage key of an attachment's bytes. */
  const keyOf = async (attachmentId: string) => {
    const [row] = await t.db.select().from(messengerAttachments).where(eq(messengerAttachments.id, attachmentId));
    const [object] = await t.db
      .select()
      .from(objects)
      .where(eq(objects.id, row?.objectId ?? ''));
    return object?.key ?? '';
  };

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const box = new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]);
    published = [];
    const events: EventPublisher = {
      publish: async input => {
        published.push(input);
        return await Promise.resolve({ event: {} as never, created: true, subscribers: [] });
      },
    };
    store = new FilesystemObjectStore({
      root: await mkdtemp(nodePath.join(tmpdir(), 'mocco-messenger-')),
      baseUrl: 'https://mocco.test/api/ext/internal/storage',
      signer: new StorageUrlSigner('test-signing-key'),
    });
    const storage = new StorageService({ objects: new ObjectRepo(t.db), store });
    messenger = createMessengerDomain(t.db, {
      audit,
      box: () => box,
      storage,
      events,
      appOrigin: 'https://mocco.test',
    });
    const { projects } = createProjectDomain(t.db);
    const apiKeys = createApiKeyService(t.db, { projects, audit });
    app = new Hono<V1Env>().basePath('/api/ext').route(
      '/v1',
      createV1Routes({
        apiKeys,
        // A fixed clock: a run that crosses a window boundary would reset the counts.
        limiter: new MemoryRateLimiter(() => new Date('2026-10-02T10:00:30Z')),
        messenger: { contacts: messenger.contactMessenger, push: messenger.messengerPush },
      }),
    );
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const operator = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    );
    operatorId = operator.id;
    const project = await projects.create(workspaceId, { name: 'ShowYourTime', handle: 'syt' });
    projectId = project.id;
    ({ identitySecret: secret } = await messenger.messengerSettings.enable(workspaceId, projectId, operatorId));
    const created = await apiKeys.create(workspaceId, projectId, operatorId, {
      kind: ApiKeyKinds.publishable,
      name: 'app',
      scopes: [ApiScopes.messengerChat],
      expiresAt: null,
      flagEnvironmentId: null,
    });
    key = created.token;
  });
  afterEach(async () => {
    await t.close();
  });

  it('opens a session only for a user the app server signed', async () => {
    const forged = await call('POST', '/sessions', {
      token: key,
      body: { userId: 'u1', userHash: userHashOf('not-the-secret', 'u1') },
    });
    const malformed = await call('POST', '/sessions', { token: key, body: { userId: 'u1', userHash: 'abc' } });
    const noKey = await call('POST', '/sessions', { body: { userId: 'u1', userHash: userHashOf(secret, 'u1') } });
    const signed = await call('POST', '/sessions', {
      token: key,
      body: { userId: 'u1', userHash: userHashOf(secret, 'u1'), name: 'Minji', email: 'minji@example.com' },
    });

    expect([forged.status, malformed.status, noKey.status, signed.status]).toEqual([401, 400, 401, 201]);
    expect(forged.body).toMatchObject({ type: expect.stringContaining('identity_not_verified') });
    expect(signed.body).toMatchObject({
      sessionToken: expect.stringMatching(/^mms_/u),
      categories: expect.arrayContaining([{ key: 'bug', label: 'Bug report' }]),
    });
    const unknownSession = await call('GET', '/conversations', { token: 'mms_nope' });
    expect(unknownSession.status).toBe(401);
  });

  it('starts a conversation once per client message id, and rejects unknown categories', async () => {
    const token = await sessionFor('u1');
    const clientMessageId = randomUUID();
    const first = await start(token, 'The widget stopped updating', clientMessageId);
    const retried = await start(token, 'The widget stopped updating', clientMessageId);
    const unknown = await call('POST', '/conversations', {
      token,
      body: { category: 'refund-now', body: 'x', clientMessageId: randomUUID() },
    });
    const listed = await call('GET', '/conversations', { token });

    expect([first.status, retried.status, unknown.status]).toEqual([201, 201, 400]);
    expect(retried.body).toEqual(first.body);
    expect(listed.body).toEqual({
      conversations: [
        expect.objectContaining({
          status: 'open',
          category: 'bug',
          preview: 'The widget stopped updating',
          lastMessageSeq: 1,
          hasUnread: false,
        }),
      ],
    });
    expect(published.map(event => event.type)).toEqual([MessengerEventTypes.messengerConversationCreated]);
    expect(published[0]).toMatchObject({
      projectId,
      payload: {
        facts: { category: 'bug', platform: 'ios' },
        message: {
          title: 'New message from u1',
          description: 'The widget stopped updating',
          url: expect.stringContaining('/inbox/'),
        },
      },
    });
  });

  it("shows the team's replies but never its internal notes, with unread until read", async () => {
    const token = await sessionFor('u1');
    const { body } = await start(token);
    const conversationId = (body as unknown as { conversation: { id: string } }).conversation.id;
    await messenger.inbox.write(workspaceId, projectId, operatorId, {
      conversationId,
      body: 'Customer is on an old build',
      internal: true,
    });
    await messenger.inbox.write(workspaceId, projectId, operatorId, {
      conversationId,
      body: 'Fixed in 3.8.1. Update, then add the widget again.',
      internal: false,
    });

    const messages = await call('GET', `/conversations/${conversationId}/messages`, { token });
    const unread = await call('GET', '/conversations', { token });
    await call('POST', `/conversations/${conversationId}/read`, { token, body: { seq: 3 } });
    const read = await call('GET', '/conversations', { token });
    const after = await call('GET', `/conversations/${conversationId}/messages?afterSeq=1`, { token });

    expect(messages.body).toEqual({
      messages: [
        expect.objectContaining({ seq: 1, author: 'contact', body: 'The widget stopped updating', authorName: null }),
        expect.objectContaining({ seq: 3, author: 'operator', authorName: 'Ada' }),
      ],
    });
    expect(JSON.stringify(messages.body)).not.toContain('old build');
    expect(unread.body).toMatchObject({
      conversations: [{ hasUnread: true, preview: 'Fixed in 3.8.1. Update, then add the widget again.' }],
    });
    expect(read.body).toMatchObject({ conversations: [{ hasUnread: false }] });
    expect(after.body).toEqual({ messages: [expect.objectContaining({ seq: 3 })] });
  });

  it("never shows one user another user's conversation", async () => {
    const minji = await sessionFor('minji');
    const jun = await sessionFor('jun');
    const { body } = await start(minji);
    const conversationId = (body as unknown as { conversation: { id: string } }).conversation.id;

    const read = await call('GET', `/conversations/${conversationId}/messages`, { token: jun });
    const write = await call('POST', `/conversations/${conversationId}/messages`, {
      token: jun,
      body: { body: 'hello', clientMessageId: randomUUID() },
    });
    const list = await call('GET', '/conversations', { token: jun });

    expect([read.status, write.status]).toEqual([404, 404]);
    expect(list.body).toEqual({ conversations: [] });
  });

  it('reopens a closed conversation when the user writes, and stops a blocked user', async () => {
    const token = await sessionFor('u1');
    const { body } = await start(token);
    const conversationId = (body as unknown as { conversation: { id: string } }).conversation.id;
    await messenger.inbox.setStatus(workspaceId, projectId, conversationId, 'closed');

    const reply = await call('POST', `/conversations/${conversationId}/messages`, {
      token,
      body: { body: 'It happened again', clientMessageId: randomUUID() },
    });
    const listed = await call('GET', '/conversations', { token });
    const { contact } = await messenger.inbox.get(workspaceId, projectId, conversationId);
    const contactId = contact.id;
    await messenger.inbox.setContactBlocked(workspaceId, projectId, operatorId, { contactId, blocked: true });
    const blocked = await call('POST', `/conversations/${conversationId}/messages`, {
      token,
      body: { body: 'spam', clientMessageId: randomUUID() },
    });
    const newSession = await call('POST', '/sessions', {
      token: key,
      body: { userId: 'u1', userHash: userHashOf(secret, 'u1') },
    });

    expect(reply.status).toBe(201);
    expect(listed.body).toMatchObject({ conversations: [{ status: 'open' }] });
    expect(published.map(event => event.type)).toEqual([
      MessengerEventTypes.messengerConversationCreated,
      MessengerEventTypes.messengerMessageReceived,
    ]);
    expect([blocked.status, newSession.status]).toEqual([403, 403]);
  });

  it('works with the SDK client end to end, with internal notes never reaching it', async () => {
    const client = new MessengerClient({
      publishableKey: key,
      baseUrl: 'https://www.mocco.test/api/ext/v1',
      identity: async () =>
        await Promise.resolve({ userId: 'sdk-user', userHash: userHashOf(secret, 'sdk-user'), name: 'Jun' }),
      context: () => ({ appVersion: '3.8.1', platform: 'android' }),
      fetch: async (input, init) => await app.fetch(new Request(input, init)),
    });

    const conversation = await client.startConversation({ category: 'billing', body: 'Charged twice' });
    await messenger.inbox.write(workspaceId, projectId, operatorId, {
      conversationId: conversation.id,
      body: 'checked the payment provider',
      internal: true,
    });
    await messenger.inbox.write(workspaceId, projectId, operatorId, {
      conversationId: conversation.id,
      body: 'Refunded the second charge.',
      internal: false,
    });
    await client.refresh();
    const unread = client.getState().unreadCount;
    const thread = await client.loadThread(conversation.id);
    await client.markRead(conversation.id);
    await client.sendMessage(conversation.id, 'Thank you!');
    await client.refresh();
    client.close();

    expect(unread).toBe(1);
    expect(thread.map(message => [message.author, message.body])).toEqual([
      ['contact', 'Charged twice'],
      ['operator', 'Refunded the second charge.'],
    ]);
    expect(client.getState()).toMatchObject({
      status: 'ready',
      unreadCount: 0,
      conversations: [{ id: conversation.id, category: 'billing', preview: 'Thank you!' }],
    });
    const { contact } = await messenger.inbox.get(workspaceId, projectId, conversation.id);
    expect(contact).toMatchObject({ name: 'Jun', lastContext: { appVersion: '3.8.1', platform: 'android' } });
  });

  it('refuses attachments where object storage is not configured', async () => {
    const token = await sessionFor('u1');
    const principal = await messenger.contactMessenger.authenticate(token);
    if (principal === undefined) {
      throw new Error('no session');
    }
    const withoutStorage = createMessengerDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      box: () => new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]),
    });

    await expect(
      withoutStorage.contactMessenger.createAttachment(principal, { contentType: 'image/png', sizeBytes: 8 }),
    ).rejects.toThrow(/object storage isn't configured/u);
  });

  describe('guests', () => {
    it('takes guests only when the project allows them, and an email is required', async () => {
      const refused = await guestSession({ email: 'guest@example.com' });
      await messenger.messengerSettings.setAllowGuests(workspaceId, projectId, operatorId, true);
      const noEmail = await guestSession({});
      const opened = await guestSession({ email: 'guest@example.com', name: 'Guest' });
      const session = await jsonOf(opened);
      const started = await start(session.sessionToken ?? '');

      expect([refused.status, noEmail.status, opened.status, started.status]).toEqual([403, 400, 201, 201]);
      expect(session.guestToken).toMatch(/^mmg_/u);
      const conversationId = (started.body as unknown as { conversation: { id: string } }).conversation.id;
      const { contact } = await messenger.inbox.get(workspaceId, projectId, conversationId);
      expect(contact).toMatchObject({ externalUserId: null, email: 'guest@example.com', name: 'Guest' });
      expect(published.at(-1)).toMatchObject({ payload: { message: { title: 'New message from Guest' } } });
    });

    it('finds a returning guest by their device token, and keeps devices apart', async () => {
      await messenger.messengerSettings.setAllowGuests(workspaceId, projectId, operatorId, true);
      const first = await jsonOf(await guestSession({ email: 'guest@example.com' }));
      await start(first.sessionToken ?? '');
      const again = await jsonOf(await guestSession({ email: 'new@example.com', guestToken: first.guestToken }));
      const otherDevice = await jsonOf(await guestSession({ email: 'guest@example.com' }));
      const listed = await call('GET', '/conversations', { token: again.sessionToken });
      const otherList = await call('GET', '/conversations', { token: otherDevice.sessionToken });

      expect(again.contactId).toBe(first.contactId);
      expect(again.guestToken).toBeUndefined();
      expect(otherDevice.contactId).not.toBe(first.contactId);
      expect((listed.body as unknown as { conversations: unknown[] }).conversations).toHaveLength(1);
      expect(otherList.body).toEqual({ conversations: [] });
      const { contact } = await messenger.inbox.get(
        workspaceId,
        projectId,
        (listed.body as unknown as { conversations: { id: string }[] }).conversations[0]?.id ?? '',
      );
      expect(contact.email).toBe('new@example.com');
    });

    it('moves what a guest wrote to their account when they sign in on that device', async () => {
      await messenger.messengerSettings.setAllowGuests(workspaceId, projectId, operatorId, true);
      const guest = await jsonOf(await guestSession({ email: 'guest@example.com' }));
      await start(guest.sessionToken ?? '', 'Asked before signing in');
      const signedIn = await call('POST', '/sessions', {
        token: key,
        body: { userId: 'u9', userHash: userHashOf(secret, 'u9'), guestToken: guest.guestToken },
      });
      const signedInToken = (signedIn.body as unknown as { sessionToken: string }).sessionToken;
      const listed = await call('GET', '/conversations', { token: signedInToken });
      const oldGuest = await call('GET', '/conversations', { token: guest.sessionToken });
      const reused = await guestSession({ email: 'guest@example.com', guestToken: guest.guestToken });

      expect(signedIn.status).toBe(201);
      expect(listed.body).toMatchObject({ conversations: [{ preview: 'Asked before signing in' }] });
      expect(oldGuest.status).toBe(401);
      const reusedSession = await jsonOf(reused);
      expect(reusedSession.contactId).not.toBe(guest.contactId);
    });

    it('limits guest sessions per client IP', async () => {
      await messenger.messengerSettings.setAllowGuests(workspaceId, projectId, operatorId, true);
      const { limit } = MessengerRateLimits.guestSessions;
      const statuses = await Array.from({ length: limit + 1 }).reduce<Promise<number[]>>(async (previous, _, index) => {
        const done = await previous;
        const answer = await guestSession({ email: `g${index}@example.com` }, '198.51.100.4');
        return [...done, answer.status];
      }, Promise.resolve([]));
      const otherIp = await guestSession({ email: 'other@example.com' }, '198.51.100.5');

      expect(statuses.slice(0, limit).every(status => status === 201)).toBe(true);
      expect([statuses.at(-1), otherIp.status]).toEqual([429, 201]);
    });
  });

  describe('reply push', () => {
    const TOKEN = 'ExponentPushToken[abc123]';

    it('registers a device, queues a push for team replies only, and sends it unless already read', async () => {
      const queued: { payload: { conversationId: string; seq: number } }[] = [];
      const sent: { to: string; title: string; body: string; data: Record<string, string> }[] = [];
      const domain = createMessengerDomain(t.db, {
        audit: new AuditService({ audit: new AuditRepo(t.db) }),
        box: () => new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]),
        queue: {
          enqueue: async (_job, payload) => {
            queued.push({ payload: payload as { conversationId: string; seq: number } });
            return await Promise.resolve({ job: { id: 'job-1' } as never, created: true });
          },
          kick: () => {},
        },
        pushSender: {
          send: async messages => {
            sent.push(...messages);
            return await Promise.resolve(messages.map(entry => ({ to: entry.to, ok: true, isDeviceGone: false })));
          },
        },
      });
      const token = await sessionFor('u1');
      const bad = await call('POST', '/push-tokens', {
        token,
        body: { provider: 'expo', token: 'nope', platform: 'ios' },
      });
      const registered = await call('POST', '/push-tokens', {
        token,
        body: { provider: 'expo', token: TOKEN, platform: 'ios' },
      });
      const { body } = await start(token);
      const conversationId = (body as unknown as { conversation: { id: string } }).conversation.id;

      await domain.inbox.write(workspaceId, projectId, operatorId, { conversationId, body: 'note', internal: true });
      await domain.inbox.write(workspaceId, projectId, operatorId, {
        conversationId,
        body: 'Fixed in 3.8.1. Update and add the widget again.',
        internal: false,
      });
      const delivered = await domain.messengerPush.deliverReply(queued[0]?.payload ?? { conversationId, seq: 0 });
      await call('POST', `/conversations/${conversationId}/read`, { token, body: { seq: 3 } });
      const afterRead = await domain.messengerPush.deliverReply({ conversationId, seq: 3 });

      expect([bad.status, registered.status]).toEqual([400, 204]);
      expect(queued.map(entry => entry.payload)).toEqual([{ conversationId, seq: 3 }]);
      expect(delivered).toBe(1);
      expect(sent).toEqual([
        {
          to: TOKEN,
          title: 'ShowYourTime',
          body: 'Fixed in 3.8.1. Update and add the widget again.',
          data: { mocco: 'messenger', conversationId },
        },
      ]);
      expect(afterRead).toBe(0);
    });

    it('stops pushing to a device the service says is gone, and to a token the user removed', async () => {
      const sent: string[] = [];
      const domain = createMessengerDomain(t.db, {
        audit: new AuditService({ audit: new AuditRepo(t.db) }),
        box: () => new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]),
        pushSender: {
          send: async messages => {
            sent.push(...messages.map(entry => entry.to));
            return await Promise.resolve(
              messages.map(entry => ({ to: entry.to, ok: false, isDeviceGone: entry.to === TOKEN })),
            );
          },
        },
      });
      const token = await sessionFor('u1');
      await call('POST', '/push-tokens', { token, body: { provider: 'expo', token: TOKEN, platform: 'ios' } });
      const other = 'ExponentPushToken[other]';
      await call('POST', '/push-tokens', { token, body: { provider: 'expo', token: other, platform: 'android' } });
      const { body } = await start(token);
      const conversationId = (body as unknown as { conversation: { id: string } }).conversation.id;
      await domain.inbox.write(workspaceId, projectId, operatorId, { conversationId, body: 'one', internal: false });
      await domain.messengerPush.deliverReply({ conversationId, seq: 2 });
      const removed = await call('DELETE', '/push-tokens', { token, body: { token: other } });
      await domain.inbox.write(workspaceId, projectId, operatorId, { conversationId, body: 'two', internal: false });
      const second = await domain.messengerPush.deliverReply({ conversationId, seq: 3 });

      expect(removed.status).toBe(204);
      expect(sent).toEqual([TOKEN, other]);
      expect(second).toBe(0);
    });
  });

  describe('screenshots', () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    /** Reserve an attachment and upload `bytes` the way the client would PUT them. */
    const attach = async (token: string, bytes = PNG) => {
      const declared = { contentType: 'image/png', sizeBytes: PNG.length };
      const reserved = await call('POST', '/attachments', {
        token,
        body: { ...declared, filename: 'Screen Shot.png' },
      });
      expect(reserved.status).toBe(201);
      const { attachmentId, upload } = reserved.body as unknown as {
        attachmentId: string;
        upload: { url: string; method: string; headers: Record<string, string> };
      };
      const [row] = await t.db.select().from(messengerAttachments).where(eq(messengerAttachments.id, attachmentId));
      const [object] = await t.db
        .select()
        .from(objects)
        .where(eq(objects.id, row?.objectId ?? ''));
      await store.put(object?.key ?? '', bytes, { contentType: declared.contentType, visibility: 'private' });
      return { attachmentId, upload };
    };

    it('uploads a screenshot and serves it with the message that carries it', async () => {
      const token = await sessionFor('u1');
      const first = await attach(token);
      const started = await call('POST', '/conversations', {
        token,
        body: { body: 'See the screenshot', clientMessageId: randomUUID(), attachmentIds: [first.attachmentId] },
      });
      const conversationId = (started.body as unknown as { conversation: { id: string } }).conversation.id;
      const second = await attach(token);
      const clientMessageId = randomUUID();
      const sent = await call('POST', `/conversations/${conversationId}/messages`, {
        token,
        body: { body: 'And another', clientMessageId, attachmentIds: [second.attachmentId] },
      });
      const retried = await call('POST', `/conversations/${conversationId}/messages`, {
        token,
        body: { body: 'And another', clientMessageId, attachmentIds: [second.attachmentId] },
      });
      const listed = await call('GET', `/conversations/${conversationId}/messages`, { token });
      const team = await messenger.inbox.get(workspaceId, projectId, conversationId);

      expect(first.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
      expect([started.status, sent.status, retried.status]).toEqual([201, 201, 201]);
      expect(retried.body).toEqual(sent.body);
      expect(listed.body).toMatchObject({
        messages: [
          {
            seq: 1,
            attachments: [{ id: first.attachmentId, contentType: 'image/png', sizeBytes: 8, url: expect.any(String) }],
          },
          { seq: 2, attachments: [{ id: second.attachmentId }] },
        ],
      });
      expect(team.messages.map(message => message.attachments.length)).toEqual([1, 1]);
    });

    it('erases a user who asks, with every conversation and screenshot, and keeps everyone else', async () => {
      const minji = await sessionFor('minji');
      const jun = await sessionFor('jun');
      const { attachmentId } = await attach(minji);
      await call('POST', '/conversations', {
        token: minji,
        body: { body: 'Delete my account please', clientMessageId: randomUUID(), attachmentIds: [attachmentId] },
      });
      await start(jun);
      const objectKey = await keyOf(attachmentId);

      const erased = await call('DELETE', '/me', { token: minji });
      const afterwards = await call('GET', '/conversations', { token: minji });
      const fresh = await call('GET', '/conversations', { token: await sessionFor('minji') });
      const juns = await call('GET', '/conversations', { token: jun });
      const audited = await t.db.select().from(auditLog).where(eq(auditLog.action, 'messenger.contact.erased'));

      expect([erased.status, afterwards.status]).toEqual([204, 401]);
      expect(await store.get(objectKey)).toBeNull();
      expect(fresh.body).toEqual({ conversations: [] });
      expect((juns.body as unknown as { conversations: unknown[] }).conversations).toHaveLength(1);
      expect(await t.db.select().from(messengerAttachments)).toEqual([]);
      expect(await t.db.select().from(messengerMessages)).toHaveLength(1);
      expect(audited.map(entry => [entry.actorUserId, entry.payload])).toEqual([[null, { projectId, by: 'contact' }]]);
    });

    it('lets the team erase a user from the inbox, only within the project', async () => {
      const minji = await sessionFor('minji');
      const { attachmentId } = await attach(minji);
      const started = await call('POST', '/conversations', {
        token: minji,
        body: { body: 'Please remove my data', clientMessageId: randomUUID(), attachmentIds: [attachmentId] },
      });
      const conversationId = (started.body as unknown as { conversation: { id: string } }).conversation.id;
      const { contact } = await messenger.inbox.get(workspaceId, projectId, conversationId);
      const other = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Other', handle: 'other' });
      const objectKey = await keyOf(attachmentId);

      await expect(messenger.inbox.eraseContact(workspaceId, other.id, operatorId, contact.id)).rejects.toThrow();
      await messenger.inbox.eraseContact(workspaceId, projectId, operatorId, contact.id);

      await expect(messenger.inbox.get(workspaceId, projectId, conversationId)).rejects.toThrow();
      await expect(messenger.inbox.eraseContact(workspaceId, projectId, operatorId, contact.id)).rejects.toThrow();
      expect(await t.db.select().from(messengerContacts)).toEqual([]);
      expect(await store.get(objectKey)).toBeNull();
      const afterwards = await call('GET', '/conversations', { token: minji });
      expect(afterwards.status).toBe(401);
    });

    it("refuses another user's, an already used, a mis-uploaded or a non-image attachment", async () => {
      const minji = await sessionFor('minji');
      const jun = await sessionFor('jun');
      const { body } = await start(minji);
      const conversationId = (body as unknown as { conversation: { id: string } }).conversation.id;
      const juns = await attach(jun);
      const used = await attach(minji);
      await call('POST', `/conversations/${conversationId}/messages`, {
        token: minji,
        body: { body: 'one', clientMessageId: randomUUID(), attachmentIds: [used.attachmentId] },
      });
      const short = await attach(minji, PNG.slice(0, 4));
      const send = async (attachmentId: string) =>
        await call('POST', `/conversations/${conversationId}/messages`, {
          token: minji,
          body: { body: 'x', clientMessageId: randomUUID(), attachmentIds: [attachmentId] },
        });

      const answers = await Promise.all([send(juns.attachmentId), send(used.attachmentId), send(short.attachmentId)]);
      const pdf = await call('POST', '/attachments', {
        token: minji,
        body: { contentType: 'application/pdf', sizeBytes: 10 },
      });
      const huge = await call('POST', '/attachments', {
        token: minji,
        body: { contentType: 'image/png', sizeBytes: 11 * 1024 * 1024 },
      });

      expect(answers.map(answer => answer.status)).toEqual([400, 400, 400]);
      expect(answers[2]?.body).toMatchObject({ detail: expect.stringContaining('expected 8 bytes, got 4') });
      expect([pdf.status, huge.status]).toEqual([400, 400]);
    });
  });

  it('limits how fast one user can write', async () => {
    const token = await sessionFor('u1');
    const { body } = await start(token);
    const conversationId = (body as unknown as { conversation: { id: string } }).conversation.id;
    const { limit } = MessengerRateLimits.messages;

    const statuses = await Array.from({ length: limit + 1 }).reduce<Promise<number[]>>(async (previous, _, index) => {
      const done = await previous;
      const answer = await call('POST', `/conversations/${conversationId}/messages`, {
        token,
        body: { body: `message ${index}`, clientMessageId: randomUUID() },
      });
      return [...done, answer.status];
    }, Promise.resolve([]));

    expect(statuses.slice(0, limit).every(status => status === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
