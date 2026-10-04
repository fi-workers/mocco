import { tcpMonitorSpecSchema } from '@mocco/common/status';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runTcpCheck } from './tcp-check';
import { allowAll, testContext } from './testing/context';
import { closedPort, startTcpFixture, type FixtureServer } from './testing/fixtures';

/** A resolver that never answers. */
const neverAnswers = async () =>
  await new Promise<never>(() => {
    // Never settles.
  });

const tcp = (input: Record<string, unknown>) => tcpMonitorSpecSchema.parse({ kind: 'tcp', ...input });

describe('runTcpCheck', () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startTcpFixture();
  });

  afterAll(async () => {
    await server.close();
  });

  it('passes when the connection opens, with its timings', async () => {
    const report = await runTcpCheck(tcp({ host: '127.0.0.1', port: server.port }), testContext());

    expect(report).toMatchObject({ outcome: 'ok', timings: { dns: 0, connect: expect.any(Number) } });
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('resolves a name first', async () => {
    const report = await runTcpCheck(tcp({ host: 'localhost', port: server.port }), testContext());

    expect(report.outcome).toBe('ok');
  });

  it('fails with connect when the port is closed', async () => {
    const report = await runTcpCheck(tcp({ host: '127.0.0.1', port: await closedPort() }), testContext());

    expect(report).toMatchObject({ outcome: 'fail', errorKind: 'connect' });
  });

  it('fails with dns for a name that does not resolve', async () => {
    const report = await runTcpCheck(tcp({ host: 'db.nowhere.invalid', port: 5432 }), testContext());

    expect(report).toMatchObject({ outcome: 'fail', errorKind: 'dns' });
  });

  it('fails with timeout when the whole check (resolution included) runs past its deadline', async () => {
    const report = await runTcpCheck(
      tcp({ host: 'slow.example.test', port: 5432, timeoutMs: 1000 }),
      testContext(allowAll, neverAnswers),
    );

    expect(report).toMatchObject({ outcome: 'fail', errorKind: 'timeout' });
  });
});
