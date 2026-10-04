// HTTP checks against a local fixture server: status, keyword, latency, timeout, redirects and
// the TLS certificate's expiry. Nothing here leaves the machine.
import { httpMonitorSpecSchema } from '@mocco/common/status';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runHttpCheck } from './http-check';
import { testContext } from './testing/context';
import { closedPort, FIXTURE_CERT_EXPIRES_AT, startHttpFixture, type FixtureServer } from './testing/fixtures';

const spec = (input: Record<string, unknown>) => httpMonitorSpecSchema.parse({ kind: 'http', ...input });

describe('runHttpCheck', () => {
  let server: FixtureServer;
  let tls: FixtureServer;

  beforeAll(async () => {
    server = await startHttpFixture();
    tls = await startHttpFixture('https');
  });

  afterAll(async () => {
    await server.close();
    await tls.close();
  });

  it('passes a 2xx and reports its status, latency and timings', async () => {
    const report = await runHttpCheck(spec({ url: server.url('/ok') }), testContext());

    expect(report).toMatchObject({ outcome: 'ok', statusCode: 200 });
    expect(report.errorKind).toBeUndefined();
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.timings).toEqual({
      dns: 0,
      connect: expect.any(Number),
      ttfb: expect.any(Number),
    });
  });

  it('fails a status outside the expected set, and passes one inside it', async () => {
    const down = await runHttpCheck(spec({ url: server.url('/status/503') }), testContext());
    const expected = await runHttpCheck(spec({ url: server.url('/status/404'), expectedStatus: [404] }), testContext());

    expect(down).toMatchObject({ outcome: 'fail', errorKind: 'status', statusCode: 503, detail: 'HTTP 503' });
    expect(expected).toMatchObject({ outcome: 'ok', statusCode: 404 });
  });

  it('checks a keyword that must be present, or absent', async () => {
    const url = server.url('/ok');
    const found = await runHttpCheck(spec({ url, keyword: 'fixture' }), testContext());
    const missing = await runHttpCheck(spec({ url, keyword: 'maintenance' }), testContext());
    const forbidden = await runHttpCheck(spec({ url, keyword: 'hello', keywordMode: 'absent' }), testContext());

    expect(found.outcome).toBe('ok');
    expect(missing).toMatchObject({ outcome: 'fail', errorKind: 'keyword' });
    expect(forbidden).toMatchObject({ outcome: 'fail', errorKind: 'keyword', detail: '"hello" found in the response' });
  });

  it('looks for a keyword only in the first megabyte', async () => {
    const report = await runHttpCheck(spec({ url: server.url('/big'), keyword: 'needle' }), testContext());

    expect(report).toMatchObject({ outcome: 'fail', errorKind: 'keyword' });
  });

  it('passes a slow answer but marks it over the latency threshold', async () => {
    const report = await runHttpCheck(spec({ url: server.url('/slow?ms=120'), latencyThresholdMs: 50 }), testContext());

    expect(report).toMatchObject({ outcome: 'ok', errorKind: 'latency' });
    expect(report.latencyMs).toBeGreaterThanOrEqual(100);
  });

  it('fails with a timeout when no answer comes in time', async () => {
    const report = await runHttpCheck(spec({ url: server.url('/hang'), timeoutMs: 1000 }), testContext());

    expect(report).toMatchObject({ outcome: 'fail', errorKind: 'timeout' });
    expect(report.latencyMs).toBeGreaterThanOrEqual(990);
    // It ends at the deadline, not whenever the server gives up (a loaded runner only adds a little).
    expect(report.latencyMs).toBeLessThan(10_000);
  });

  it('fails with connect when nothing listens, and dns when the name does not resolve', async () => {
    const refused = await runHttpCheck(spec({ url: `http://127.0.0.1:${await closedPort()}/` }), testContext());
    const unknown = await runHttpCheck(spec({ url: 'http://nowhere.invalid/' }), testContext());

    expect(refused).toMatchObject({ outcome: 'fail', errorKind: 'connect' });
    expect(refused.detail).toContain('ECONNREFUSED');
    expect(unknown).toMatchObject({ outcome: 'fail', errorKind: 'dns' });
  });

  describe('redirects', () => {
    it('follows them to the final answer', async () => {
      const to = encodeURIComponent(server.url('/redirect?to=/ok'));
      const report = await runHttpCheck(
        spec({ url: server.url(`/redirect?to=${to}`), keyword: 'fixture' }),
        testContext(),
      );

      expect(report).toMatchObject({ outcome: 'ok', statusCode: 200 });
    });

    it('judges the redirect itself when following is off', async () => {
      const report = await runHttpCheck(spec({ url: server.url('/redirect'), followRedirects: false }), testContext());

      expect(report).toMatchObject({ outcome: 'fail', errorKind: 'status', statusCode: 302 });
    });

    it('gives up after five', async () => {
      const report = await runHttpCheck(spec({ url: server.url('/loop') }), testContext());

      expect(report).toMatchObject({ outcome: 'fail', errorKind: 'status', detail: 'More than 5 redirects' });
    });

    it('continues a POST as a GET after a 303', async () => {
      const report = await runHttpCheck(
        spec({
          url: server.url(`/redirect?status=303&to=/method`),
          method: 'POST',
          body: '{}',
          keyword: 'method=GET',
        }),
        testContext(),
      );

      expect(report.outcome).toBe('ok');
    });
  });

  describe('TLS', () => {
    it('reports when the certificate expires, and its timings', async () => {
      const report = await runHttpCheck(spec({ url: tls.url('/ok') }), testContext());

      expect(report).toMatchObject({ outcome: 'ok', statusCode: 200, tlsExpiresAt: FIXTURE_CERT_EXPIRES_AT });
      expect(report.timings).toEqual(expect.objectContaining({ tls: expect.any(Number) }));
      expect(report.detail).toBeUndefined();
    });

    it('says how many days are left once inside the warning window, and still passes', async () => {
      // 2026-10-05 to 2036-10-01 is 3648 days.
      const report = await runHttpCheck(spec({ url: tls.url('/ok'), tlsWarnDays: 365 }), testContext());
      const warned = await runHttpCheck(spec({ url: tls.url('/ok'), tlsWarnDays: 365 }), {
        ...testContext(),
        now: () => new Date('2036-09-01T00:00:00.000Z'),
      });

      expect(report.detail).toBeUndefined();
      expect(warned).toMatchObject({ outcome: 'ok', detail: 'TLS certificate expires in 30 days' });
    });

    it('fails with tls when the certificate does not match the name', async () => {
      // The fixture certificate is for localhost and 127.0.0.1, not this name.
      const context = testContext(undefined, async () => await Promise.resolve([{ address: '127.0.0.1', family: 4 }]));
      const report = await runHttpCheck(spec({ url: `https://status.example.test:${tls.port}/ok` }), context);

      expect(report).toMatchObject({ outcome: 'fail', errorKind: 'tls' });
    });
  });
});
