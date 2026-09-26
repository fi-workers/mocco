import { InboundKinds, InboundOutcomes } from '@mocco/common/inbound';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INBOUND_MAX_BODY_BYTES, IngestOutcomes, IngestStatuses } from '@backend/domain/inbound/constants';
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

import type { InboundService, IngestResult } from '@backend/domain/inbound/InboundService';

const WELL_FORMED_KEY = 'A'.repeat(43);
const SECRET_KEY = `s3cr3t${'k'.repeat(37)}`;

const ACCEPTED: IngestResult = { status: IngestStatuses.accepted, outcome: IngestOutcomes.published };

/** An ingest stand-in that counts calls and answers `result`. */
function recordingInbound(result: IngestResult = ACCEPTED) {
  const spy = {
    calls: 0,
    ingest: async (): Promise<IngestResult> => {
      spy.calls += 1;
      return await Promise.resolve(result);
    },
  };
  return spy;
}

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
    const res = await post(undefined, WELL_FORMED_KEY, signedDelivery(InboundKinds.github, 's'));
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

  it('404s a well-formed but unknown ingest key with a fixed body', async () => {
    const { inbound } = await setup();

    const res = await post(inbound, WELL_FORMED_KEY, signedDelivery(InboundKinds.github, 's'));

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });

  it.each(['short', `${'a'.repeat(43)}b`, `${'a'.repeat(42)}.`, `${'a'.repeat(42)}%2F`])(
    '404s the malformed key %j without calling the service',
    async key => {
      const spy = recordingInbound();

      const res = await post(spy, key, signedDelivery(InboundKinds.github, 's'));

      expect(res.status).toBe(404);
      expect(await res.text()).toBe('not found');
      expect(spy.calls).toBe(0);
    },
  );

  it('413s a body over 1 MB without calling the service', async () => {
    const spy = recordingInbound();
    const body = new Uint8Array(INBOUND_MAX_BODY_BYTES + 1);

    const res = await post(spy, WELL_FORMED_KEY, { body, headers: new Headers() });

    expect(res.status).toBe(413);
    expect(spy.calls).toBe(0);
  });

  it('passes a body of exactly 1 MB through, and maps 429 to a fixed body', async () => {
    const spy = recordingInbound({ status: IngestStatuses.tooManyRequests });
    const body = new Uint8Array(INBOUND_MAX_BODY_BYTES);

    const res = await post(spy, WELL_FORMED_KEY, { body, headers: new Headers() });

    expect(res.status).toBe(429);
    expect(await res.text()).toBe('too many deliveries');
    expect(spy.calls).toBe(1);
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
      ingest: async () => await Promise.reject(new TypeError(`select … where ingest_key = $1 params: ${SECRET_KEY}`)),
    };

    const res = await post(failing, SECRET_KEY, signedDelivery(InboundKinds.github, 's'));

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal server error');
    expect(JSON.stringify(logged)).not.toContain(SECRET_KEY);
    expect(logged).toContain('TypeError');
  });
});
