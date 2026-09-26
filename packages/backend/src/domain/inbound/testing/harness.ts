// Test-only wiring for the inbound domain (never imported by production code): the
// real services over pglite, a SecretBox with a random key, the real event bus, and
// signed deliveries per vendor built from the adapter fixtures.
import { randomBytes } from 'node:crypto';

import { InboundKinds } from '@mocco/common/inbound';

import { createTestEventBus } from '@backend/domain/events/testing/event-bus';
import { createInboundDomain } from '@backend/domain/inbound/instance';
import { encode, hmacHex, patchFixture, readFixture } from '@backend/domain/inbound/testing/fixtures';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { workspaces } from '@backend/infra/db/schema';

import type { EventPublisher } from '@backend/domain/events/ports';
import type { Db } from '@backend/infra/db/types';
import type { InboundKind } from '@mocco/common/inbound';

export const TEST_ORIGIN = 'https://www.mocco.test';

export function createTestSecretBox(): SecretBox {
  return new SecretBox([{ id: 'test', key: randomBytes(32) }]);
}

export interface InboundHarnessOptions {
  now?: () => Date;
  bus?: EventPublisher;
}

/** The inbound services over `db`, as production composes them. */
export function createInboundHarness(db: Db, options: InboundHarnessOptions = {}) {
  const now = options.now ?? (() => new Date());
  const box = createTestSecretBox();
  const bus = options.bus ?? createTestEventBus(db, now);
  return { box, ...createInboundDomain(db, { box, bus, now, baseOrigin: TEST_ORIGIN }) };
}

/** A bare workspace row (inbound tests need no members). */
export async function insertWorkspace(db: Db, name: string): Promise<string> {
  const [row] = await db.insert(workspaces).values({ name, slug: name }).returning();
  if (row === undefined) {
    throw new Error('workspace insert returned nothing');
  }
  return row.id;
}

/** The ingest key at the end of a source's ingest URL. */
export function ingestKeyOf(ingestUrl: string): string {
  // sonarjs/null-dereference is a false positive: `ingestUrl` is a required string.
  // eslint-disable-next-line sonarjs/null-dereference
  const key = ingestUrl.split('/').at(-1);
  if (key === undefined) {
    throw new Error(`no ingest key in ${ingestUrl}`);
  }
  return key;
}

export interface Delivery {
  body: Uint8Array;
  headers: Headers;
}

export interface DeliveryOptions {
  deliveryId?: string;
  /** Sign with this secret instead of the source's. */
  signWith?: string;
  /** Replace the fixture body (still signed). */
  body?: Uint8Array;
  /** Drop the delivery id header (GitHub, Sentry) or payload id (Vercel). */
  withoutDeliveryId?: boolean;
}

/**
 * A delivery the vendor would send for `kind`, signed with `secret`: a Sentry issue
 * created, a Vercel production deployment succeeded, or a GitHub push. Each maps to
 * an event.
 */
export function signedDelivery(kind: InboundKind, secret: string, options: DeliveryOptions = {}): Delivery {
  const id = options.deliveryId ?? `delivery-${randomBytes(6).toString('hex')}`;
  const signer = options.signWith ?? secret;
  if (kind === InboundKinds.vercel) {
    const text = patchFixture('vercel/deployment-succeeded-production.json', {
      id: options.withoutDeliveryId === true ? undefined : id,
    });
    const body = options.body ?? encode(text);
    return { body, headers: new Headers({ 'x-vercel-signature': hmacHex('sha1', signer, body) }) };
  }
  if (kind === InboundKinds.sentry) {
    const body = options.body ?? encode(readFixture('sentry/issue-created.json'));
    const headers = new Headers({
      'sentry-hook-resource': 'issue',
      'sentry-hook-signature': hmacHex('sha256', signer, body),
    });
    if (options.withoutDeliveryId !== true) {
      headers.set('request-id', id);
    }
    return { body, headers };
  }
  const body = options.body ?? encode(readFixture('github/push.json'));
  const headers = new Headers({
    'x-github-event': 'push',
    'x-hub-signature-256': `sha256=${hmacHex('sha256', signer, body)}`,
  });
  if (options.withoutDeliveryId !== true) {
    headers.set('x-github-delivery', id);
  }
  return { body, headers };
}
