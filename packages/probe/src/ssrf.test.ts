// A hosted probe refuses private, loopback, link-local and metadata targets (ADR 0027 §7):
// directly, after a redirect, and when a public-looking name resolves to a private address.
// The fixture server listens on 127.0.0.1, so these tests allow exactly that address and hold
// everything else to the real block list.
import { httpMonitorSpecSchema, tcpMonitorSpecSchema } from '@mocco/common/status';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isPublicAddress } from './address-policy';
import { runHttpCheck } from './http-check';
import { runTcpCheck } from './tcp-check';
import { hostedExcept, tableLookup, testContext } from './testing/context';
import { startHttpFixture, startTcpFixture, type FixtureServer } from './testing/fixtures';

import type { Lookup } from './resolve';

const FIXTURE_ADDRESS = '127.0.0.1';
/** The hosted policy, except for the fixture's own address. */
const hosted = (lookup?: Lookup) => testContext(hostedExcept(FIXTURE_ADDRESS), lookup);

const http = (input: Record<string, unknown>) => httpMonitorSpecSchema.parse({ kind: 'http', ...input });

describe('hosted probe address policy', () => {
  let server: FixtureServer;
  let tcp: FixtureServer;

  beforeAll(async () => {
    server = await startHttpFixture();
    tcp = await startTcpFixture();
  });

  afterAll(async () => {
    await server.close();
    await tcp.close();
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://[::1]/',
    'http://[fd00:ec2::254]/',
    'http://100.64.0.1/',
  ])('refuses %s before connecting', async url => {
    const report = await runHttpCheck(http({ url }), hosted());

    expect(report).toMatchObject({ outcome: 'fail', errorKind: 'connect' });
    expect(report.detail).toContain('an address this probe may not reach');
  });

  it('refuses the loopback fixture itself under the plain hosted policy', async () => {
    const report = await runHttpCheck(http({ url: server.url('/ok') }), testContext(isPublicAddress));

    expect(report).toMatchObject({ outcome: 'fail', errorKind: 'connect' });
  });

  it('refuses a redirect to a blocked address', async () => {
    const to = encodeURIComponent('http://169.254.169.254/latest/meta-data/');
    const report = await runHttpCheck(http({ url: server.url(`/redirect?to=${to}`) }), hosted());

    expect(report).toMatchObject({ outcome: 'fail', errorKind: 'connect' });
    expect(report.detail).toContain('169.254.169.254');
  });

  it('refuses a redirect to a name that resolves to a private address', async () => {
    const lookup = tableLookup({ 'internal.example.test': ['10.1.2.3'] });
    const to = encodeURIComponent('http://internal.example.test/admin');
    const report = await runHttpCheck(http({ url: server.url(`/redirect?to=${to}`) }), hosted(lookup));

    expect(report).toMatchObject({ outcome: 'fail', errorKind: 'connect' });
    expect(report.detail).toContain('10.1.2.3');
  });

  it('refuses a name that resolves to a private address, even next to a public one', async () => {
    const lookup = tableLookup({
      'private.example.test': ['192.168.0.10'],
      'mixed.example.test': ['8.8.8.8', '10.0.0.7'],
    });

    const privateOnly = await runHttpCheck(http({ url: 'http://private.example.test/' }), hosted(lookup));
    const mixed = await runHttpCheck(http({ url: 'http://mixed.example.test/' }), hosted(lookup));

    expect(privateOnly).toMatchObject({ outcome: 'fail', errorKind: 'connect' });
    expect(mixed).toMatchObject({ outcome: 'fail', errorKind: 'connect' });
    expect(mixed.detail).toContain('10.0.0.7');
  });

  it('connects to the address it checked, so a rebinding DNS gets no second answer', async () => {
    // First answer: the allowed fixture. Any later answer would be a private address.
    const answers = [[FIXTURE_ADDRESS], ['10.9.9.9']];
    let calls = 0;
    const rebinding: Lookup = async () => {
      const addresses = answers[Math.min(calls, answers.length - 1)] ?? [];
      calls += 1;
      return await Promise.resolve(addresses.map(address => ({ address, family: 4 })));
    };

    const report = await runHttpCheck(http({ url: `http://rebind.example.test:${server.port}/ok` }), hosted(rebinding));

    expect(report).toMatchObject({ outcome: 'ok', statusCode: 200 });
    expect(calls).toBe(1);
  });

  it('holds TCP checks to the same policy', async () => {
    const blocked = await runTcpCheck(
      tcpMonitorSpecSchema.parse({ kind: 'tcp', host: '127.0.0.1', port: tcp.port }),
      testContext(isPublicAddress),
    );
    const metadata = await runTcpCheck(
      tcpMonitorSpecSchema.parse({ kind: 'tcp', host: '169.254.169.254', port: 80 }),
      hosted(),
    );

    expect(blocked).toMatchObject({ outcome: 'fail', errorKind: 'connect' });
    expect(metadata).toMatchObject({ outcome: 'fail', errorKind: 'connect' });
  });

  it('lets a private location reach private targets', async () => {
    const report = await runHttpCheck(http({ url: server.url('/ok') }), testContext());

    expect(report.outcome).toBe('ok');
  });
});
