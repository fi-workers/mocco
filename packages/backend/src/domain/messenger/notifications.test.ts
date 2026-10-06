// Operator notifications for new conversations (#204) on pglite: a conversation start goes
// through the real event bus and notification fan-out to a channel, and the channel's
// sender (a fake Discord, never the real one) is called once per conversation event, even
// when the start is retried and the event handed over again.
import { randomUUID } from 'node:crypto';

import { MessengerEventTypes } from '@mocco/common/events';
import { DeliveryStatuses } from '@mocco/common/notification';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createEventBus } from '@backend/domain/events/subscriptions';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { createMessengerDomain } from '@backend/domain/messenger/compose';
import { userHashOf } from '@backend/domain/messenger/identity';
import { NotificationSubscribers } from '@backend/domain/notification/constants';
import { DeliveryService } from '@backend/domain/notification/DeliveryService';
import { ChannelRepo } from '@backend/domain/notification/repos/channel.repo';
import { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import { DiscordRateLimitRepo } from '@backend/domain/notification/repos/discord-rate-limit.repo';
import { DiscordApi } from '@backend/domain/notification/senders/discord';
import { createFakeDiscordFetch, jsonResponse } from '@backend/domain/notification/testing/fake-discord-fetch';
import { seedChannel, seedRule } from '@backend/domain/notification/testing/seed';
import { createProjectDomain } from '@backend/domain/project/instance';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import { domainEvents, members, notificationDeliveries, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { EventBus } from '@backend/domain/events/EventBus';
import type { MessengerDomain } from '@backend/domain/messenger/compose';
import type { ContactPrincipal } from '@backend/domain/messenger/ContactMessengerService';

const APP_ORIGIN = 'https://www.mocco.test';

describe('messenger operator notifications (pglite, fake Discord)', () => {
  let t: TestDb;
  let bus: EventBus;
  let messenger: MessengerDomain;
  let workspaceId: string;
  let projectId: string;
  let ada: string;
  let principal: ContactPrincipal;

  beforeEach(async () => {
    t = await createTestDb();
    const queue = new PostgresJobQueue({
      jobs: new JobRepo(t.db),
      now: () => new Date(),
      // Kicks run nothing: the test hands events and deliveries over itself.
      runOne: async () => await Promise.resolve(null),
      waitUntil: () => {},
    });
    bus = createEventBus({ db: t.db, queue, now: () => new Date(), appOrigin: APP_ORIGIN });
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const box = new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]);
    messenger = createMessengerDomain(t.db, { audit, box: () => box, events: bus, appOrigin: APP_ORIGIN });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    ada = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    await t.db.insert(members).values({ organizationId: workspaceId, userId: ada, role: 'member' });
    const { projects } = createProjectDomain(t.db);
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    const { identitySecret } = await messenger.messengerSettings.enable(workspaceId, projectId, ada);
    const session = await messenger.contactMessenger.createSession(
      { workspaceId, projectId },
      { userId: 'minji', userHash: userHashOf(identitySecret, 'minji'), name: 'Minji' },
    );
    const found = await messenger.contactMessenger.authenticate(session.sessionToken);
    if (found === undefined) {
      throw new Error('no session');
    }
    principal = found;
  });
  afterEach(async () => {
    await t.close();
  });

  /** Hand every stored event to the messenger fan-out, as `events.deliver` would. */
  const fanOutAll = async () => {
    const events = await t.db.select().from(domainEvents).where(eq(domainEvents.workspaceId, workspaceId));
    await events.reduce(async (previous, event) => {
      await previous;
      await bus.deliver(event.id, NotificationSubscribers.messenger.name);
    }, Promise.resolve());
    return events;
  };

  /** Run every queued delivery through the sender, as `notification.deliver` would. */
  const sendAll = async (delivery: DeliveryService) => {
    const rows = await t.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.workspaceId, workspaceId));
    await rows.reduce(async (previous, row) => {
      await previous;
      await delivery.deliver(row.id, { isFinalAttempt: false, now: new Date() });
    }, Promise.resolve());
    return rows;
  };

  const fakeDiscord = () => {
    const fake = createFakeDiscordFetch(jsonResponse(200, { id: '1001' }), jsonResponse(200, { id: '1002' }));
    const discord = new DiscordApi({
      fetch: fake.fetch,
      botToken: 'bot-token-secret',
      now: () => new Date(),
      timeoutMs: 1000,
    });
    const delivery = new DeliveryService({
      deliveries: new DeliveryRepo(t.db),
      channels: new ChannelRepo(t.db),
      rateLimits: new DiscordRateLimitRepo(t.db),
      discord,
      random: () => 0,
    });
    return { delivery, requests: fake.requests };
  };

  it('sends one unassigned notification per conversation, however often it is announced', async () => {
    const channel = await seedChannel(t.db, workspaceId, 'support');
    await seedRule(t.db, channel, { eventType: MessengerEventTypes.messengerConversationUnassigned });
    const clientMessageId = randomUUID();
    const first = await messenger.contactMessenger.startConversation(principal, {
      body: 'I was charged twice',
      clientMessageId,
    });
    // The app retries the start (a lost response): same conversation, no new event.
    const retried = await messenger.contactMessenger.startConversation(principal, {
      body: 'I was charged twice',
      clientMessageId,
    });
    expect(retried.id).toBe(first.id);

    const events = await fanOutAll();
    // A redelivered event job hands the same events over again.
    await fanOutAll();
    const { delivery, requests } = fakeDiscord();
    const sent = await sendAll(delivery);
    // A second run of each delivery job finds it sent and sends nothing.
    await sendAll(delivery);

    expect(events).toHaveLength(2);
    expect(new Set(events.map(event => event.type))).toEqual(
      new Set([MessengerEventTypes.messengerConversationCreated, MessengerEventTypes.messengerConversationUnassigned]),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toMatchObject({
      title: 'No one is available for Minji',
      url: `${APP_ORIGIN}/workspaces/${workspaceId}/p/${projectId}/inbox/${first.id}`,
    });
    expect(requests).toHaveLength(1);
    const [stored] = await t.db.select().from(notificationDeliveries);
    expect(stored?.status).toBe(DeliveryStatuses.sent);
  });

  it('says who a new conversation went to, and raises no unassigned event when someone took it', async () => {
    const channel = await seedChannel(t.db, workspaceId, 'support');
    await seedRule(t.db, channel, { eventType: 'messenger.*' });
    await messenger.inbox.addMember(workspaceId, projectId, ada, ada);
    await messenger.contactMessenger.startConversation(principal, {
      body: 'How do I export?',
      clientMessageId: randomUUID(),
    });

    const events = await fanOutAll();
    const { delivery, requests } = fakeDiscord();
    const sent = await sendAll(delivery);

    expect(events.map(event => event.type)).toEqual([MessengerEventTypes.messengerConversationCreated]);
    expect(sent[0]?.message.fields).toContainEqual({ name: 'Assigned to', value: 'Ada', inline: true });
    expect(requests).toHaveLength(1);
  });
});
