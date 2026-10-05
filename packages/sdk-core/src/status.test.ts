import { describe, expect, it } from 'vitest';

import { MoccoClient } from './client';
import { MoccoError } from './errors';
import { StatusClient } from './status';

import type { StatusLocation } from './status';

const KEY = 'mk_sec_0123456789abcdefghijklmnopqrstuv';

/** A fake Mocco answering `items` in turn (the last one again once they run out). */
const responses = (...items: (() => Response)[]) => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = items[Math.min(calls.length - 1, items.length - 1)];
    return await Promise.resolve(next === undefined ? new Response(null, { status: 204 }) : next());
  };
  const status = new StatusClient(
    new MoccoClient({
      key: KEY,
      baseUrl: 'https://mocco.test/v1/',
      fetch: fetchImpl,
      isBrowser: false,
      sleep: async () => {},
    }),
  );
  return { calls, status };
};

const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });
const problem = (status: number, code: string) => () =>
  Response.json(
    { type: `https://mocco.dev/problems/${code}`, title: code, status, detail: `${code} detail` },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const location = (overrides: Partial<StatusLocation>): StatusLocation => ({
  id: 'id',
  code: 'fra',
  name: 'Frankfurt',
  kind: 'hosted',
  disabled: false,
  ...overrides,
});

describe('StatusClient', () => {
  it('upserts a monitor by key with a PUT, and retries it on a 503', async () => {
    const result = { outcome: 'unchanged', monitor: { id: 'm1' }, heartbeatToken: null };
    const { calls, status } = responses(problem(503, 'unavailable'), json(result));
    const input = { name: 'API', spec: { kind: 'http' as const, url: 'https://api.acme.test/health' } };

    expect(await status.monitors.upsert('api health', input)).toEqual(result);

    expect(calls).toEqual([
      { method: 'PUT', url: 'https://mocco.test/v1/monitors/by-key/api%20health', body: input },
      { method: 'PUT', url: 'https://mocco.test/v1/monitors/by-key/api%20health', body: input },
    ]);
  });

  it("doesn't retry a POST that changes something", async () => {
    const { calls, status } = responses(problem(503, 'unavailable'), json({}));

    await expect(status.monitors.pause('m1')).rejects.toBeInstanceOf(MoccoError);
    expect(calls).toHaveLength(1);
  });

  it('calls each route with its method, path and body, and unwraps the lists', async () => {
    const { calls, status } = responses(
      json({ monitors: [{ id: 'm1' }] }),
      json({ pages: [{ id: 'p1' }] }),
      json({ components: [{ id: 'c1' }] }),
      json({ id: 'c1' }),
      json({ incidents: [] }),
      json({ incident: { id: 'i1' } }, 201),
      json({ incident: { id: 'i1' } }, 201),
      json({ incident: { id: 'i1' } }),
      json({ maintenances: [] }),
      json({ id: 'w1' }, 201),
      json({ id: 'w1' }),
      () => new Response(null, { status: 204 }),
    );

    expect(await status.monitors.list()).toEqual([{ id: 'm1' }]);
    expect(await status.pages.list()).toEqual([{ id: 'p1' }]);
    expect(await status.components.list('p1')).toEqual([{ id: 'c1' }]);
    await status.components.setStatus('c1', 'degraded');
    await status.incidents.list('p1', { open: true });
    await status.incidents.create({ pageId: 'p1', title: 'Down', severity: 'major', body: 'Looking.' });
    await status.incidents.update('i1', { status: 'resolved', body: 'Fixed.' });
    await status.incidents.setComponents('i1', []);
    await status.maintenances.list('p1');
    await status.maintenances.schedule({
      pageId: 'p1',
      title: 'Upgrade',
      scheduledStart: new Date('2030-01-01T00:00:00Z'),
      scheduledEnd: '2030-01-01T01:00:00Z',
    });
    await status.maintenances.cancel('w1');
    await status.monitors.delete('m1');

    expect(calls.map(call => `${call.method} ${call.url.replace('https://mocco.test/v1', '')}`)).toEqual([
      'GET /monitors',
      'GET /pages',
      'GET /pages/p1/components',
      'PATCH /components/c1',
      'GET /incidents?pageId=p1&open=true',
      'POST /incidents',
      'POST /incidents/i1/updates',
      'PUT /incidents/i1/components',
      'GET /maintenances?pageId=p1',
      'POST /maintenances',
      'POST /maintenances/w1/cancel',
      'DELETE /monitors/m1',
    ]);
    expect(calls[3]?.body).toEqual({ status: 'degraded' });
    expect(calls[7]?.body).toEqual({ components: [] });
    // A Date becomes an ISO string on the wire.
    expect(calls[9]?.body).toMatchObject({
      scheduledStart: '2030-01-01T00:00:00.000Z',
      scheduledEnd: '2030-01-01T01:00:00Z',
    });
  });

  it("turns a refusal into MoccoError with the problem's code", async () => {
    const { status } = responses(problem(403, 'insufficient_scope'));

    await expect(status.monitors.list()).rejects.toMatchObject({ status: 403, code: 'insufficient_scope' });
  });

  it("finds locations' ids by code, the workspace's own first, and refuses an unknown or disabled one", async () => {
    const locations = [
      location({ id: 'hosted-fra', code: 'fra' }),
      location({ id: 'own-fra', code: 'fra', kind: 'private' }),
      location({ id: 'office', code: 'office', kind: 'private' }),
      location({ id: 'old', code: 'old', kind: 'private', disabled: true }),
    ];
    const { status } = responses(json({ locations }));

    expect(await status.locations.idsOf(['office', 'fra'])).toEqual(['office', 'own-fra']);
    await expect(status.locations.idsOf(['old'])).rejects.toThrow('No enabled location with the code "old"');
    await expect(status.locations.idsOf(['sin'])).rejects.toMatchObject({ status: 404, code: 'unknown' });
  });
});
