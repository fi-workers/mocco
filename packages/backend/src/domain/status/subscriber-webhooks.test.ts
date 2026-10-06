// Webhook subscribers (#156) on pglite, through the real job runner and a local receiver: the
// secret shown once and sealed at rest, the confirmation event as the double opt-in, signed
// events only after confirming, a 410 that unsubscribes, and the address check at sign-up.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { isPublicAddress } from '@mocco/common/address-policy';
import { ComponentStatuses, IncidentSeverities, IncidentStatuses } from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { WebhookSender } from '@backend/domain/notification/senders/webhook';
import { createRecordingEmailSender } from '@backend/domain/notification/testing/recording-email';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { SubscriberWebhookUrlError } from '@backend/domain/status/errors';
import { SubscriberTokens } from '@backend/domain/status/subscriber-token';
import { SubscribeOutcomes } from '@backend/domain/status/SubscriberService';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import { statusSubscribers, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createJobRunner } from '@backend/runtime/jobs';

import type { JobRunner } from '@backend/domain/jobs/JobRunner';
import type { StatusDomain } from '@backend/domain/status/compose';
import type { StatusScope } from '@backend/domain/status/scope';
import type { SubscriberService } from '@backend/domain/status/SubscriberService';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const T0 = new Date('2026-10-06T09:00:00.000Z');

interface Hit {
  headers: IncomingHttpHeaders;
  body: string;
}

/** Whether a hit carries a valid Standard Webhooks signature for `secret`. */
function isSigned(hit: Hit, secret: string): boolean {
  // eslint-disable-next-line unicorn/prefer-uint8array-base64, sonarjs/null-dereference -- Buffer is the codec here; secret is a string
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const id = String(hit.headers['webhook-id']);
  const timestamp = String(hit.headers['webhook-timestamp']);
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${hit.body}`).digest('base64');
  return hit.headers['webhook-signature'] === `v1,${mac}`;
}

const typesOf = (hits: readonly Hit[]) => hits.map(hit => (JSON.parse(hit.body) as { type: string }).type);

describe('webhook subscribers (pglite)', () => {
  let t: TestDb;
  let server: Server;
  let hits: Hit[];
  let replyStatus: number;
  let hookUrl: string;
  let status: StatusDomain;
  let subscribers: SubscriberService;
  let runner: JobRunner;
  let scope: StatusScope;
  let actor: string;
  let kicked: Promise<unknown>[];

  const drain = async (): Promise<void> => {
    const report = await runner.tick({ budgetMs: 60_000, maxJobs: 500 });
    expect(report.errors).toEqual([]);
    const running = [...kicked];
    kicked.length = 0;
    await Promise.all(running);
    if (report.ran > 0 || running.length > 0) {
      await drain();
    }
  };

  const openIncident = async (pageId: string) =>
    await status.statusIncidents.create(scope, actor, {
      pageId,
      title: 'Elevated errors',
      severity: IncidentSeverities.major,
      status: IncidentStatuses.investigating,
      body: 'Looking into it.',
      components: [],
    });

  beforeEach(async () => {
    t = await createTestDb();
    hits = [];
    replyStatus = 204;
    kicked = [];
    server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        hits.push({ headers: request.headers, body });
        response.writeHead(replyStatus);
        response.end();
      });
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    hookUrl = `http://127.0.0.1:${String(port)}/hooks/status`;
    const deps = {
      tokens: new SubscriberTokens('test-subscriber-key'),
      email: createRecordingEmailSender(),
      box: new SecretBox([{ id: 'a', key: randomBytes(32) }]),
      // Production's policy, plus the local receiver.
      webhooks: new WebhookSender({
        policy: address => address === '127.0.0.1' || isPublicAddress(address),
        isHttpAllowed: true,
      }),
    };
    const queue = new PostgresJobQueue({
      jobs: new JobRepo(t.db),
      now: () => T0,
      runOne: async () => await Promise.resolve(null),
      waitUntil: () => {},
    });
    status = createStatusDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      queue,
      appOrigin: 'https://mocco.test',
      subscribers: deps,
      now: () => T0,
    });
    if (status.statusSubscribers === undefined) {
      throw new Error('no subscriber service');
    }
    subscribers = status.statusSubscribers;
    runner = createJobRunner(t.db, {
      now: () => T0,
      random: () => 0,
      workerId: 'test',
      waitUntil: promise => {
        kicked.push(promise);
      },
      appOrigin: 'https://mocco.test',
      discord: undefined,
      storage: undefined,
      statusSubscribers: deps,
    });
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId, projectId: project.id };
  });
  afterEach(async () => {
    await new Promise(resolve => {
      server.close(resolve);
    });
    await t.close();
  });

  it('confirms through the confirmation event, then sends signed events', async () => {
    const page = await status.statusPages.createPage(scope, actor, { slug: 'acme', title: 'Acme status' });
    const { outcome, secret } = await subscribers.subscribeWebhook('acme', { url: hookUrl });
    expect(outcome).toBe(SubscribeOutcomes.confirmationQueued);
    if (secret === undefined) {
      throw new Error('no secret returned');
    }
    const row = expectOne(await t.db.select().from(statusSubscribers));
    // Sealed at rest: the secret itself is nowhere in the row.
    expect(row.webhookSecretSealed).not.toContain(secret.slice('whsec_'.length));
    await drain();
    // Before confirming, an incident sends nothing to the hook.
    await openIncident(page.id);
    await drain();

    expect(typesOf(hits)).toEqual(['subscription.confirmation']);
    const [confirmation] = hits;
    if (confirmation === undefined) {
      throw new Error('no confirmation event');
    }
    expect(isSigned(confirmation, secret)).toBe(true);
    const event = JSON.parse(confirmation.body) as { links: { confirm: string; unsubscribe: string }; page: unknown };
    expect(event.page).toEqual({ slug: 'acme', title: 'Acme status' });
    const token = new URL(event.links.confirm).searchParams.get('token') ?? '';
    await subscribers.confirm('acme', token);

    await openIncident(page.id);
    await drain();
    expect(typesOf(hits)).toEqual(['subscription.confirmation', 'incident.updated']);
    const update = hits[1];
    expect(update !== undefined && isSigned(update, secret)).toBe(true);
    expect(JSON.parse(update?.body ?? '{}')).toMatchObject({
      type: 'incident.updated',
      data: { incidentTitle: 'Elevated errors', status: 'investigating', body: 'Looking into it.' },
      links: { unsubscribe: expect.stringContaining('/api/ext/v1/status-pages/acme/subscribers/unsubscribe?token=') },
    });
    // A URL already following the page keeps its secret.
    expect(await subscribers.subscribeWebhook('acme', { url: hookUrl })).toEqual({
      outcome: SubscribeOutcomes.alreadySubscribed,
    });
  });

  it('unsubscribes a receiver that answers 410 Gone', async () => {
    const page = await status.statusPages.createPage(scope, actor, { slug: 'acme', title: 'Acme status' });
    await subscribers.subscribeWebhook('acme', { url: hookUrl });
    await drain();
    const event = JSON.parse(hits[0]?.body ?? '{}') as { links: { confirm: string } };
    await subscribers.confirm('acme', new URL(event.links.confirm).searchParams.get('token') ?? '');
    replyStatus = 410;
    await openIncident(page.id);
    await drain();

    const row = expectOne(await t.db.select().from(statusSubscribers).where(eq(statusSubscribers.pageId, page.id)));
    expect(row.unsubscribedAt).toEqual(T0);
    await openIncident(page.id);
    await drain();
    expect(hits).toHaveLength(2);
  });

  it('refuses a URL whose host is an address that is not public', async () => {
    await status.statusPages.createPage(scope, actor, { slug: 'acme', title: 'Acme status' });
    const refused = async (url: string) => {
      await expect(subscribers.subscribeWebhook('acme', { url })).rejects.toBeInstanceOf(SubscriberWebhookUrlError);
    };

    await refused('https://169.254.169.254/latest/meta-data');
    await refused('https://[::1]:8443/hook');
    await refused('https://10.0.0.7/hook');
    expect(await t.db.select().from(statusSubscribers)).toEqual([]);
  });

  it('keeps the components of a webhook sign-up to the page', async () => {
    const page = await status.statusPages.createPage(scope, actor, { slug: 'acme', title: 'Acme status' });
    const api = await status.statusPages.createComponent(scope, page.id, { name: 'API' });
    await subscribers.subscribeWebhook('acme', { url: hookUrl, componentIds: [api.id] });
    const row = expectOne(await t.db.select().from(statusSubscribers));
    expect(row).toMatchObject({ channel: 'webhook', webhookUrl: hookUrl, email: null, componentIds: [api.id] });
    expect(ComponentStatuses.operational).toBe('operational');
  });
});
