import { randomUUID } from 'node:crypto';

import { OtaEventTypes } from '@mocco/common/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OtaMetricsRepo } from '@backend/domain/ota/repos/ota-metrics.repo';
import { otaAdoptionDaily, otaClientEvents, otaDevices } from '@backend/infra/db/schema';
import { API, createOtaFixture, RUNTIME } from '@backend/transport/ext/v1/testing/ota-fixture';

import type { PublishInput } from '@backend/domain/events/EventBus';
import type { OtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';

describe('OTA adoption metrics and client events', () => {
  let f: OtaFixture;
  let published: PublishInput[];
  let v1: { releaseId: string; updateId: string };
  let v2: { releaseId: string; updateId: string };

  /** An update check from a device, reporting what it runs. */
  const check = async (clientId: string, currentUpdateId?: string) =>
    await f.app.fetch(
      new Request(`${API}/ota/apps/${f.otaAppId}/manifest`, {
        headers: {
          'expo-protocol-version': '1',
          'expo-platform': 'ios',
          'expo-runtime-version': RUNTIME,
          'expo-channel-name': 'staging',
          'eas-client-id': clientId,
          'x-forwarded-for': '203.0.113.7',
          ...(currentUpdateId !== undefined && { 'expo-current-update-id': currentUpdateId }),
        },
      }),
    );

  const report = async (body: unknown, raw?: string) =>
    await f.app.fetch(
      new Request(`${API}/ota/apps/${f.otaAppId}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
        body: raw ?? JSON.stringify(body),
      }),
    );

  beforeEach(async () => {
    published = [];
    f = await createOtaFixture({
      events: {
        publish: async input => {
          published.push(input);
          return await Promise.resolve({ event: { id: randomUUID() }, created: true } as never);
        },
      },
    });
    const staging = await f.ota.otaHosting.createChannel(f.appRow, f.ownerId, { name: 'staging', policy: null });
    v1 = await f.publishReady('v1');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v1.releaseId, f.ownerId, null);
    v2 = await f.publishReady('v2');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v2.releaseId, f.ownerId, null);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f.close();
  });

  it('counts adoption correctly as devices move between updates', async () => {
    await check('device-a', v1.updateId);
    await check('device-b', v1.updateId);
    await f.ota.otaMetrics.flush();
    // device-a takes v2 and checks again.
    await check('device-a', v2.updateId);
    await f.ota.otaMetrics.flush();

    await f.ota.otaMetrics.rollup();

    const rows = await f.t.db.select().from(otaAdoptionDaily);
    const byUpdate = Object.fromEntries(rows.map(row => [row.updateId, row.activeDevices]));
    expect(byUpdate).toEqual({ [v1.updateId]: 1, [v2.updateId]: 1 });
    const [adoption] = await f.ota.otaMetrics.releaseAdoption(f.appRow, [v2.releaseId]);
    expect(adoption).toMatchObject({ releaseId: v2.releaseId, activeDevices: 1 });
    expect(adoption?.daily).toHaveLength(1);
  });

  it('writes a repeated sighting once, and never stores the raw client id or the IP address', async () => {
    const spy = vi.spyOn(OtaMetricsRepo.prototype, 'upsertDevices');

    await check('device-secret-id-123', v2.updateId);
    await check('device-secret-id-123', v2.updateId);
    await f.ota.otaMetrics.flush();
    await report({
      clientId: 'device-secret-id-123',
      platform: 'ios',
      events: [{ type: 'launched', updateId: v2.updateId }],
    });

    expect(spy.mock.calls.flatMap(([rows]) => rows)).toHaveLength(1);
    const stored = JSON.stringify([
      await f.t.db.select().from(otaDevices),
      await f.t.db.select().from(otaClientEvents),
    ]);
    expect(stored).not.toContain('device-secret-id-123');
    expect(stored).not.toContain('203.0.113.7');
  });

  it('accepts bounded event batches and refuses oversized or malformed ones', async () => {
    const accepted = await report({
      clientId: 'device-c',
      platform: 'ios',
      events: [{ type: 'error', updateId: v2.updateId, detail: { message: 'TypeError: x is undefined' } }],
    });
    const oversized = await report(undefined, JSON.stringify({ padding: 'x'.repeat(17 * 1024) }));
    const malformed = await report({ clientId: 'device-c', platform: 'ios', events: [] });

    expect([accepted.status, oversized.status, malformed.status]).toEqual([202, 413, 400]);
  });

  it('alerts once a release falls back to the embedded bundle on too many devices', async () => {
    const devices = Array.from({ length: 6 }, (_, index) => `device-${index}`);
    await Promise.all(devices.map(async id => await check(id, v2.updateId)));
    await f.ota.otaMetrics.flush();
    await Promise.all(
      devices.map(
        async clientId =>
          await report({ clientId, platform: 'ios', events: [{ type: 'emergency_launch', updateId: v2.updateId }] }),
      ),
    );

    const { alerts } = await f.ota.otaMetrics.rollup();

    expect(alerts).toBe(1);
    const spike = published.find(event => event.type === OtaEventTypes.otaEmergencyLaunchSpike);
    expect(spike).toMatchObject({
      dedupeKey: expect.stringContaining(v2.updateId),
      payload: { facts: { release: v2.releaseId }, message: { title: expect.stringMatching(/^Emergency launches:/u) } },
    });
  });

  it('prunes events and devices past retention', async () => {
    await check('device-old', v2.updateId);
    await f.ota.otaMetrics.flush();
    await report({ clientId: 'device-old', platform: 'ios', events: [{ type: 'launched', updateId: v2.updateId }] });
    const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await f.t.db.update(otaDevices).set({ lastSeenAt: longAgo });
    await f.t.db.update(otaClientEvents).set({ occurredAt: longAgo });

    expect(await f.ota.otaMetrics.prune()).toEqual({ events: 1, devices: 1 });
  });
});
