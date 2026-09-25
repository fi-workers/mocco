import { InboundKinds, InboundOutcomes } from '@mocco/common/inbound';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encode, readFixture } from '@backend/domain/inbound/testing/fixtures';
import {
  createInboundHarness,
  ingestKeyOf,
  insertWorkspace,
  signedDelivery,
} from '@backend/domain/inbound/testing/harness';
import { domainEvents, inboundReceipts } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createInboundRoutes } from '@backend/transport/ext/inbound';

import type { InboundService } from '@backend/domain/inbound/InboundService';

async function post(
  inbound: Pick<InboundService, 'ingest'> | undefined,
  ingestKey: string,
  delivery: { body: Uint8Array; headers: Headers },
) {
  const request = new Request(`https://local.test/inbound/${ingestKey}`, {
    method: 'POST',
    headers: delivery.headers,
    // Its own ArrayBuffer-backed copy, which BodyInit accepts.
    body: new Uint8Array(delivery.body),
  });
  return await createInboundRoutes(inbound).fetch(request);
}

describe('inbound ingest route (pglite)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  const setup = async () => {
    const h = createInboundHarness(t.db);
    const workspaceId = await insertWorkspace(t.db, 'acme');
    const { source, generatedSecret } = await h.sources.create(workspaceId, { kind: InboundKinds.github, name: 'r' });
    return { ...h, ingestKey: ingestKeyOf(source.ingestUrl), secret: generatedSecret ?? '' };
  };

  it('503s when inbound is not configured', async () => {
    const res = await post(undefined, 'any', signedDelivery(InboundKinds.github, 's'));
    expect(res.status).toBe(503);
  });

  it('answers 202 accepted and publishes a signed delivery', async () => {
    const { inbound, ingestKey, secret } = await setup();

    const res = await post(inbound, ingestKey, signedDelivery(InboundKinds.github, secret));

    expect(res.status).toBe(202);
    expect(await res.text()).toBe('accepted');
    expect(await t.db.select().from(domainEvents)).toHaveLength(1);
  });

  it('reads the raw bytes: a BOM-prefixed body signed over its bytes verifies and publishes', async () => {
    const { inbound, ingestKey, secret } = await setup();
    const body = new Uint8Array([0xef, 0xbb, 0xbf, ...encode(readFixture('github/push.json'))]);

    const res = await post(inbound, ingestKey, signedDelivery(InboundKinds.github, secret, { body }));

    expect(res.status).toBe(202);
    const [receipt] = await t.db.select().from(inboundReceipts);
    expect(receipt?.outcome).toBe(InboundOutcomes.published);
  });

  it('reads the raw bytes: an invalid UTF-8 body signed over its bytes is recorded as ignored', async () => {
    const { inbound, ingestKey, secret } = await setup();
    const text = encode(readFixture('github/push.json'));
    const body = new Uint8Array([...text.slice(0, 10), 0xff, ...text.slice(10)]);

    const res = await post(inbound, ingestKey, signedDelivery(InboundKinds.github, secret, { body }));

    expect(res.status).toBe(202);
    const [receipt] = await t.db.select().from(inboundReceipts);
    expect(receipt?.outcome).toBe(InboundOutcomes.ignored);
  });

  it('401s a bad signature with a fixed body and writes nothing', async () => {
    const { inbound, ingestKey } = await setup();

    const res = await post(inbound, ingestKey, signedDelivery(InboundKinds.github, 'x', { signWith: 'wrong' }));

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('invalid signature');
    expect(await t.db.select().from(inboundReceipts)).toHaveLength(0);
  });

  it('404s an unknown ingest key with a fixed body', async () => {
    const { inbound } = await setup();

    const res = await post(inbound, 'unknown-key', signedDelivery(InboundKinds.github, 's'));

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });

  it('400s a delivery without an id', async () => {
    const { inbound, ingestKey, secret } = await setup();

    const res = await post(
      inbound,
      ingestKey,
      signedDelivery(InboundKinds.github, secret, { withoutDeliveryId: true }),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('missing delivery id');
  });

  it('turns an unexpected failure into a bare 500 that leaks nothing, and logs only the error class', async () => {
    const logged: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });
    const failing: Pick<InboundService, 'ingest'> = {
      ingest: async () => await Promise.reject(new TypeError('select … where ingest_key = $1 params: s3cr3t-key')),
    };

    const res = await post(failing, 's3cr3t-key', signedDelivery(InboundKinds.github, 's'));

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal server error');
    expect(JSON.stringify(logged)).not.toContain('s3cr3t');
    expect(logged).toContain('TypeError');
  });
});
