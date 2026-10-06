// /v1/messenger (#95) end to end on pglite: sessions for server-signed users, starting
// and continuing conversations, the team's replies (with attachments, #430), and the
// isolation between users, projects and workspaces.
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
import {
  AttachmentContentMismatchError,
  AttachmentNotFoundError,
  ConversationNotFoundError,
} from '@backend/domain/messenger/errors';
import { userHashOf } from '@backend/domain/messenger/identity';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { StorageContentTypeNotAllowedError, StorageObjectTooLargeError } from '@backend/domain/storage/errors';
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
import { createStorageRoutes } from '@backend/transport/ext/storage';
import { MessengerRateLimits } from '@backend/transport/ext/v1/messenger';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { PublishInput } from '@backend/domain/events/EventBus';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { MessengerDomain } from '@backend/domain/messenger/compose';
import type { V1Env } from '@backend/transport/ext/v1/middleware';
import type { AttachmentDto } from '@mocco/common/messenger';

const BASE = 'https://www.mocco.test/api/ext/v1/messenger';

const jsonOf = async (response: Response) => (await response.json()) as Record<string, string>;

const conversationOf = (answer: { body?: Record<string, never> }) =>
  (answer.body as unknown as { conversation: { id: string } }).conversation.id;

const PNG_DECLARED = { contentType: 'image/png', filename: 'Screen Shot.png' };

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
  const signer = new StorageUrlSigner('test-signing-key');

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

  const sendWith = async (token: string, conversationId: string, attachmentIds: string[]) =>
    await call('POST', `/conversations/${conversationId}/messages`, {
      token,
      body: { body: 'x', clientMessageId: randomUUID(), attachmentIds },
    });
  /** Follow a served link through the filesystem driver's route. */
  const fetchStored = async (url: string) =>
    await new Hono().basePath('/api/ext').route('/', createStorageRoutes({ store, signer })).fetch(new Request(url));

  const teamReply = async (
    conversationId: string,
    attachmentIds: string[],
    opts: { internal?: boolean; userId?: string; scope?: { workspaceId: string; projectId: string } } = {},
  ) => {
    const scope = opts.scope ?? { workspaceId, projectId };
    return await messenger.inbox.write(scope.workspaceId, scope.projectId, opts.userId ?? operatorId, {
      conversationId,
      body: 'Here you go',
      internal: opts.internal ?? false,
      attachmentIds,
    });
  };
  const addOperator = async (name: string) =>
    expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name })
        .returning(),
    ).id;
  /** A conversation a contact started in another project (and workspace, when given). */
  const conversationElsewhere = async (otherWorkspaceId = workspaceId) => {
    const other = await createProjectDomain(t.db).projects.create(otherWorkspaceId, {
      name: 'Other',
      handle: `other-${randomUUID().slice(0, 8)}`,
    });
    const scope = { workspaceId: otherWorkspaceId, projectId: other.id };
    const { identitySecret } = await messenger.messengerSettings.enable(otherWorkspaceId, other.id, operatorId);
    const session = await messenger.contactMessenger.createSession(scope, {
      userId: 'elsewhere',
      userHash: userHashOf(identitySecret, 'elsewhere'),
    });
    const principal = await messenger.contactMessenger.authenticate(session.sessionToken);
    if (principal === undefined) {
      throw new Error('no session');
    }
    const started = await messenger.contactMessenger.startConversation(principal, {
      body: 'Hello from the other app',
      clientMessageId: randomUUID(),
    });
    return { scope, conversationId: started.id };
  };

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
      signer,
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

  describe('attachments', () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    /** Reserve an attachment and upload `bytes` the way the client would PUT them. */
    const attach = async (
      token: string,
      bytes = PNG,
      declared: { contentType: string; filename: string } = PNG_DECLARED,
      sizeBytes = bytes.length,
    ) => {
      const reserved = await call('POST', '/attachments', { token, body: { ...declared, sizeBytes } });
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
    const attachPdf = async (token: string, bytes = PDF) =>
      await attach(token, bytes, { contentType: 'application/pdf', filename: 'Invoice March.pdf' });

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
      // The same stored message; its attachment links are signed per request, so they may differ.
      const idOf = (answer: typeof sent) => (answer.body as unknown as { message: { id: string } }).message.id;
      expect(idOf(retried)).toBe(idOf(sent));
      expect(listed.body).toMatchObject({
        messages: [
          {
            seq: 1,
            attachments: [
              {
                id: first.attachmentId,
                contentType: 'image/png',
                sizeBytes: 8,
                filename: 'screen-shot.png',
                url: expect.any(String),
              },
            ],
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

    it("refuses another user's, an already used, a mis-uploaded or a disallowed attachment", async () => {
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
      const short = await attach(minji, PNG.slice(0, 4), undefined, PNG.length);
      const send = async (attachmentId: string) =>
        await call('POST', `/conversations/${conversationId}/messages`, {
          token: minji,
          body: { body: 'x', clientMessageId: randomUUID(), attachmentIds: [attachmentId] },
        });

      const answers = await Promise.all([send(juns.attachmentId), send(used.attachmentId), send(short.attachmentId)]);
      const reserve = async (contentType: string, sizeBytes = 10) =>
        await call('POST', '/attachments', { token: minji, body: { contentType, sizeBytes } });
      const refused = await Promise.all([
        reserve('image/svg+xml'),
        reserve('text/html'),
        reserve('image/png', 11 * 1024 * 1024),
        reserve('application/pdf', 10 * 1024 * 1024 + 1),
      ]);
      const allowed = await reserve('application/pdf', 10 * 1024 * 1024);

      expect(answers.map(answer => answer.status)).toEqual([400, 400, 400]);
      expect(answers[2]?.body).toMatchObject({ detail: expect.stringContaining('expected 8 bytes, got 4') });
      expect(refused.map(answer => answer.status)).toEqual([400, 400, 400, 400]);
      expect(allowed.status).toBe(201);
    });

    it('takes a PDF and serves it only as a download, while a screenshot stays inline', async () => {
      const token = await sessionFor('u1');
      const pdf = await attachPdf(token);
      const png = await attach(token);
      const started = await call('POST', '/conversations', {
        token,
        body: {
          body: 'My invoice',
          clientMessageId: randomUUID(),
          attachmentIds: [pdf.attachmentId, png.attachmentId],
        },
      });
      const listed = await call('GET', `/conversations/${conversationOf(started)}/messages`, { token });
      const [message] = (listed.body as unknown as { messages: { attachments: AttachmentDto[] }[] }).messages;
      const served = new Map(message?.attachments.map(attachment => [attachment.contentType, attachment]));
      const team = await messenger.inbox.get(workspaceId, projectId, conversationOf(started));
      const pdfLink = served.get('application/pdf')?.url ?? '';
      const [pdfRead, pngRead, stripped] = await Promise.all([
        fetchStored(pdfLink),
        fetchStored(served.get('image/png')?.url ?? ''),
        fetchStored(pdfLink.replace(/&dl=[^&]*/u, '')),
      ]);

      expect(started.status).toBe(201);
      expect(served.get('application/pdf')).toMatchObject({
        id: pdf.attachmentId,
        sizeBytes: PDF.length,
        filename: 'invoice-march.pdf',
      });
      expect(pdfRead.status).toBe(200);
      expect(pdfRead.headers.get('content-type')).toBe('application/pdf');
      expect(pdfRead.headers.get('content-disposition')).toBe('attachment; filename="invoice-march.pdf"');
      expect(pdfRead.headers.get('x-content-type-options')).toBe('nosniff');
      expect(new Uint8Array(await pdfRead.arrayBuffer())).toEqual(PDF);
      expect(pngRead.status).toBe(200);
      expect(pngRead.headers.get('content-disposition')).toBeNull();
      // The download is part of the signature: a link stripped of it is refused.
      expect(stripped.status).toBe(404);
      expect(
        team.messages[0]?.attachments.find(attachment => attachment.contentType === 'application/pdf'),
      ).toMatchObject({ filename: 'invoice-march.pdf', url: expect.stringContaining('dl=invoice-march.pdf') });
    });

    it('refuses bytes that are not the declared type, and deletes them', async () => {
      const token = await sessionFor('u1');
      const conversationId = conversationOf(await start(token));
      const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
      const cases = [
        await attach(token, PDF), // a PDF declared as a PNG
        await attach(token, html), // HTML declared as a PNG
        await attachPdf(token, PNG), // a PNG declared as a PDF
        await attachPdf(token, html), // HTML declared as a PDF
      ];
      const keys = await Promise.all(cases.map(async ({ attachmentId }) => await keyOf(attachmentId)));

      const answers = await Promise.all(
        cases.map(async ({ attachmentId }) => await sendWith(token, conversationId, [attachmentId])),
      );
      const listed = await call('GET', `/conversations/${conversationId}/messages`, { token });

      expect(answers.map(answer => answer.status)).toEqual([400, 400, 400, 400]);
      expect(answers[0]?.body).toMatchObject({ detail: 'The uploaded file is not image/png' });
      expect(answers[2]?.body).toMatchObject({ detail: 'The uploaded file is not application/pdf' });
      expect(await Promise.all(keys.map(async objectKey => await store.get(objectKey)))).toEqual([
        null,
        null,
        null,
        null,
      ]);
      expect(await t.db.select().from(messengerAttachments)).toEqual([]);
      // Nothing was sent: only the opening message is there.
      expect((listed.body as unknown as { messages: unknown[] }).messages).toHaveLength(1);
    });

    it('never attaches one across conversations or users', async () => {
      const minji = await sessionFor('minji');
      const jun = await sessionFor('jun');
      const first = conversationOf(await start(minji));
      const second = conversationOf(await start(minji));
      const junsConversation = conversationOf(await start(jun));
      const used = await attachPdf(minji);
      const unclaimed = await attachPdf(minji);

      const inFirst = await sendWith(minji, first, [used.attachmentId]);
      const answers = await Promise.all([
        // Already in a message of the first conversation.
        sendWith(minji, second, [used.attachmentId]),
        sendWith(minji, first, [used.attachmentId]),
        // Another user's, claimed or not, even in their own conversation.
        sendWith(jun, junsConversation, [used.attachmentId]),
        sendWith(jun, junsConversation, [unclaimed.attachmentId]),
        // Nor into another user's conversation, whoever's attachment it is.
        sendWith(minji, junsConversation, [unclaimed.attachmentId]),
      ]);
      const [stored] = await t.db
        .select()
        .from(messengerAttachments)
        .where(eq(messengerAttachments.id, used.attachmentId));
      const [message] = await t.db
        .select()
        .from(messengerMessages)
        .where(eq(messengerMessages.id, stored?.messageId ?? ''));

      expect(inFirst.status).toBe(201);
      expect(answers.map(answer => answer.status)).toEqual([400, 400, 400, 400, 404]);
      expect(message?.conversationId).toBe(first);
      // The unclaimed one is still minji's to send.
      const later = await sendWith(minji, second, [unclaimed.attachmentId]);
      expect(later.status).toBe(201);
    });

    describe('from the team (#430)', () => {
      /** Reserve an attachment from the inbox and upload `bytes` the way the console would PUT them. */
      const teamAttach = async (
        conversationId: string,
        opts: {
          bytes?: Uint8Array;
          declared?: { contentType: 'image/png' | 'application/pdf'; filename: string };
          userId?: string;
          scope?: { workspaceId: string; projectId: string };
        } = {},
      ) => {
        const bytes = opts.bytes ?? PNG;
        const declared = opts.declared ?? { contentType: 'image/png' as const, filename: 'Repro steps.png' };
        const scope = opts.scope ?? { workspaceId, projectId };
        const reserved = await messenger.inbox.createAttachment(
          scope.workspaceId,
          scope.projectId,
          opts.userId ?? operatorId,
          { conversationId, ...declared, sizeBytes: bytes.length },
        );
        await store.put(await keyOf(reserved.attachmentId), bytes, {
          contentType: declared.contentType,
          visibility: 'private',
        });
        return reserved;
      };
      const teamPdf = { contentType: 'application/pdf' as const, filename: 'Refund receipt.pdf' };
      it("sends a reply's image and PDF to the user's app like any attachment", async () => {
        const token = await sessionFor('u1');
        const conversationId = conversationOf(await start(token));
        const png = await teamAttach(conversationId);
        const pdf = await teamAttach(conversationId, { bytes: PDF, declared: teamPdf });

        const message = await teamReply(conversationId, [png.attachmentId, pdf.attachmentId]);
        const listed = await call('GET', `/conversations/${conversationId}/messages`, { token });
        const [, received] = (
          listed.body as unknown as { messages: { seq: number; author: string; attachments: AttachmentDto[] }[] }
        ).messages;
        const served = new Map(received?.attachments.map(attachment => [attachment.contentType, attachment]));
        const pdfRead = await fetchStored(served.get('application/pdf')?.url ?? '');
        const team = await messenger.inbox.get(workspaceId, projectId, conversationId);
        const [object] = await t.db
          .select()
          .from(objects)
          .where(eq(objects.key, await keyOf(pdf.attachmentId)));

        expect(png.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
        expect(received).toMatchObject({ seq: message.seq, author: 'operator' });
        expect(served.get('image/png')).toMatchObject({ id: png.attachmentId, filename: 'repro-steps.png' });
        expect(served.get('application/pdf')).toMatchObject({ id: pdf.attachmentId, filename: 'refund-receipt.pdf' });
        // A PDF from the team is a download too.
        expect(pdfRead.headers.get('content-disposition')).toBe('attachment; filename="refund-receipt.pdf"');
        expect(new Uint8Array(await pdfRead.arrayBuffer())).toEqual(PDF);
        expect(team.messages.map(entry => entry.attachments.length)).toEqual([0, 2]);
        expect(object).toMatchObject({ projectId, product: 'messenger', visibility: 'private', status: 'ready' });
        expect(object?.createdByUserId).toBe(operatorId);
      });

      it("keeps an internal note's attachment in the inbox, and erases the team's files with the user", async () => {
        const token = await sessionFor('u1');
        const conversationId = conversationOf(await start(token));
        const noted = await teamAttach(conversationId, { bytes: PDF, declared: teamPdf });
        await teamReply(conversationId, [noted.attachmentId], { internal: true });
        const objectKey = await keyOf(noted.attachmentId);

        const listed = await call('GET', `/conversations/${conversationId}/messages`, { token });
        const team = await messenger.inbox.get(workspaceId, projectId, conversationId);
        expect(JSON.stringify(listed.body)).not.toContain(noted.attachmentId);
        expect(team.messages[1]?.attachments).toMatchObject([{ id: noted.attachmentId }]);

        await messenger.inbox.eraseContact(workspaceId, projectId, operatorId, team.contact.id);
        expect(await store.get(objectKey)).toBeNull();
        expect(await t.db.select().from(messengerAttachments)).toEqual([]);
      });

      it("checks the team's uploads like a user's: type, size, bytes and claim", async () => {
        const token = await sessionFor('u1');
        const conversationId = conversationOf(await start(token));
        const reserve = async (contentType: string, sizeBytes: number) =>
          await messenger.inbox.createAttachment(workspaceId, projectId, operatorId, {
            conversationId,
            contentType: contentType as 'image/png',
            sizeBytes,
          });
        const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
        const disguised = await teamAttach(conversationId, { bytes: html });
        const disguisedKey = await keyOf(disguised.attachmentId);
        const used = await teamAttach(conversationId);
        await teamReply(conversationId, [used.attachmentId]);
        const colleagues = await teamAttach(conversationId, { userId: await addOperator('Grace') });
        const usersOwn = await attach(token);

        await expect(reserve('image/svg+xml', 10)).rejects.toBeInstanceOf(StorageContentTypeNotAllowedError);
        await expect(reserve('image/png', 10 * 1024 * 1024 + 1)).rejects.toBeInstanceOf(StorageObjectTooLargeError);
        await expect(reserve('application/pdf', 10 * 1024 * 1024)).resolves.toMatchObject({
          attachmentId: expect.any(String),
        });
        await expect(teamReply(conversationId, [disguised.attachmentId])).rejects.toBeInstanceOf(
          AttachmentContentMismatchError,
        );
        expect(await store.get(disguisedKey)).toBeNull();
        // Already sent; another team member's; the user's own: none of them is the caller's to send.
        await Promise.all(
          [used.attachmentId, colleagues.attachmentId, usersOwn.attachmentId].map(async attachmentId => {
            await expect(teamReply(conversationId, [attachmentId])).rejects.toBeInstanceOf(AttachmentNotFoundError);
          }),
        );
        // Nor can the user send what the team reserved.
        const fresh = await teamAttach(conversationId);
        const fromApp = await sendWith(token, conversationId, [fresh.attachmentId]);
        expect(fromApp.status).toBe(400);
        // A refused reply wrote nothing: the opening message and the one reply.
        const team = await messenger.inbox.get(workspaceId, projectId, conversationId);
        expect(team.messages.map(entry => entry.seq)).toEqual([1, 2]);
        await expect(teamReply(conversationId, [fresh.attachmentId])).resolves.toMatchObject({ seq: 3 });
      });

      it('never reserves in or attaches across projects, workspaces or conversations', async () => {
        const token = await sessionFor('u1');
        const conversationId = conversationOf(await start(token));
        const junsConversation = conversationOf(await start(await sessionFor('jun')));
        const sameWorkspace = await conversationElsewhere();
        const otherWorkspaceId = expectOne(
          await t.db.insert(workspaces).values({ name: 'Rival', slug: randomUUID() }).returning(),
        ).id;
        const otherWorkspace = await conversationElsewhere(otherWorkspaceId);
        const here = await teamAttach(conversationId);
        const there = await teamAttach(sameWorkspace.conversationId, { scope: sameWorkspace.scope });

        await Promise.all(
          [sameWorkspace, otherWorkspace].map(async elsewhere => {
            // Reserving reaches a conversation only through its own project.
            await expect(teamAttach(elsewhere.conversationId)).rejects.toBeInstanceOf(ConversationNotFoundError);
            await expect(
              messenger.inbox.createAttachment(elsewhere.scope.workspaceId, elsewhere.scope.projectId, operatorId, {
                conversationId,
                contentType: 'image/png',
                sizeBytes: PNG.length,
              }),
            ).rejects.toBeInstanceOf(ConversationNotFoundError);
            // This project's upload can't go into another project's conversation.
            await expect(
              teamReply(elsewhere.conversationId, [here.attachmentId], { scope: elsewhere.scope }),
            ).rejects.toBeInstanceOf(AttachmentNotFoundError);
          }),
        );
        // Another project's upload can't be claimed here, nor this conversation's in another.
        await expect(teamReply(conversationId, [there.attachmentId])).rejects.toBeInstanceOf(AttachmentNotFoundError);
        await expect(teamReply(junsConversation, [here.attachmentId])).rejects.toBeInstanceOf(AttachmentNotFoundError);
        await expect(teamReply(sameWorkspace.conversationId, [here.attachmentId])).rejects.toBeInstanceOf(
          ConversationNotFoundError,
        );

        const stored = await t.db.select().from(messengerAttachments);
        expect(stored.every(row => row.messageId === null)).toBe(true);
        // Each is still its own conversation's to send.
        await expect(teamReply(conversationId, [here.attachmentId])).resolves.toMatchObject({ seq: 2 });
        await expect(
          teamReply(sameWorkspace.conversationId, [there.attachmentId], { scope: sameWorkspace.scope }),
        ).resolves.toMatchObject({ seq: 2 });
      });
    });

    it('lets storage collect an upload nobody sent after 24 hours', async () => {
      const token = await sessionFor('u1');
      const conversationId = conversationOf(await start(token));
      const reserved = await call('POST', '/attachments', {
        token,
        body: { contentType: 'application/pdf', sizeBytes: PDF.length, filename: 'never-sent.pdf' },
      });
      const { attachmentId } = reserved.body as unknown as { attachmentId: string };
      const objectKey = await keyOf(attachmentId);
      const ledger = new ObjectRepo(t.db);
      const hoursLater = (hours: number) =>
        new StorageService({ objects: ledger, store, now: () => new Date(Date.now() + hours * 60 * 60 * 1000) });
      // The client uploads the bytes but never sends the message.
      await store.put(objectKey, PDF, { contentType: 'application/pdf', visibility: 'private' });

      const early = await hoursLater(23).collectGarbage();
      const late = await hoursLater(25).collectGarbage();
      const [object] = await t.db.select().from(objects).where(eq(objects.key, objectKey));
      const sent = await sendWith(token, conversationId, [attachmentId]);

      expect([early.abandoned, late.abandoned]).toEqual([0, 1]);
      expect(object?.status).toBe('deleted');
      expect(await store.get(objectKey)).toBeNull();
      expect(sent.status).toBe(400);
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
