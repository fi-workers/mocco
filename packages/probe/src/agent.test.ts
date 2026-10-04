// The agent loop against a fake Mocco: lease → run → results → heartbeat, retries with
// backoff, a refused token, unknown monitor kinds, and a clean stop. The checks themselves are
// stubbed; the client is the real one, over HTTP to a local server.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { CheckOutcomes, type MonitorSpec } from '@mocco/common/status';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProbeAgent, type AgentTiming, type Logger } from './agent';
import { ProbeClient } from './client';
import { ProbeAuthError } from './errors';

import type { CheckReport } from './check-report';
import type { AddressInfo } from 'node:net';

interface Call {
  path: string;
  body: Record<string, unknown>;
  at: number;
  authorization: string | undefined;
}

interface Answer {
  status: number;
  body?: unknown;
}
type Responder = (call: Call, calls: Call[]) => Answer;

const TOKEN = 'mpl_test-token';
const TCP_SPEC: MonitorSpec = { kind: 'tcp', host: 'db.internal', port: 5432, timeoutMs: 1000 };
const FAST: Partial<AgentTiming> = {
  maxJitterMs: 0,
  flushDelayMs: 10,
  heartbeatIntervalMs: 40,
  backoffBaseMs: 40,
  backoffMaxMs: 1000,
};

const leaseOf = (overrides: Partial<{ roundAt: Date; spec: unknown }> = {}) => {
  const roundAt = overrides.roundAt ?? new Date();
  return {
    leaseId: randomUUID(),
    monitorId: randomUUID(),
    roundAt: roundAt.toISOString(),
    expiresAt: new Date(roundAt.getTime() + 30_000).toISOString(),
    spec: overrides.spec ?? TCP_SPEC,
  };
};

const empty: Answer = { status: 200, body: { leases: [], pollAfterMs: 30 } };

/** A fake Mocco: records every call and answers by route. */
async function startMocco(routes: Partial<Record<'/lease' | '/results' | '/heartbeat', Responder>>) {
  const calls: Call[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const path = (request.url ?? '').replace('/api/ext/v1/probe', '');
      const call: Call = {
        path,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        at: Date.now(),
        authorization: request.headers.authorization,
      };
      calls.push(call);
      const defaults: Record<string, Answer> = {
        '/lease': empty,
        '/results': { status: 202, body: { accepted: 1, duplicates: 0, rejected: [] } },
        '/heartbeat': { status: 204 },
      };
      const responder = routes[path as keyof typeof routes];
      const answer = responder === undefined ? (defaults[path] ?? { status: 404 }) : responder(call, calls);
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    callsTo: (path: string) => calls.filter(call => call.path === path),
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => {
        server.close(resolve);
      });
    },
  };
}

const quietLog = (): Logger & { warnings: string[] } => {
  const warnings: string[] = [];
  return {
    warnings,
    info: () => undefined,
    warn: message => {
      warnings.push(message);
    },
  };
};

/**
 * Waits until the fake server has seen what the assertion needs. Every wait is on a condition,
 * never a fixed sleep, and the timeout is generous so a slow CI runner only makes it slower.
 */
const eventually = async (assertion: () => void): Promise<void> => {
  await vi.waitFor(assertion, { timeout: 15_000, interval: 10 });
};

const ok: CheckReport = { outcome: CheckOutcomes.ok, latencyMs: 12, timings: { connect: 3 } };

// Above `eventually`'s timeout, so a slow wait fails with its assertion rather than the test timeout.
describe('ProbeAgent', { timeout: 30_000 }, () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    const pending = [...cleanups];
    cleanups.length = 0;
    await Promise.all(pending.map(async cleanup => await cleanup()));
  });

  const setup = async (
    routes: Parameters<typeof startMocco>[0],
    runCheck: (spec: MonitorSpec) => Promise<CheckReport> = async () => await Promise.resolve(ok),
  ) => {
    const mocco = await startMocco(routes);
    cleanups.push(mocco.close);
    const log = quietLog();
    const agent = new ProbeAgent({
      api: new ProbeClient({ baseUrl: mocco.url, token: TOKEN, agentVersion: '9.9.9' }),
      runCheck,
      concurrency: 4,
      log,
      timing: FAST,
      random: () => 1,
    });
    const controller = new AbortController();
    const running = agent.run(controller.signal);
    return {
      mocco,
      log,
      controller,
      stop: async () => {
        controller.abort();
        await running;
      },
      running,
    };
  };

  it('leases, runs each check, posts its result and heartbeats', async () => {
    const lease = leaseOf();
    const runCheck = vi.fn(async () => await Promise.resolve(ok));
    const { mocco, stop } = await setup(
      {
        '/lease': (_call, calls) =>
          calls.length === 1 ? { status: 200, body: { leases: [lease], pollAfterMs: 30 } } : empty,
      },
      runCheck,
    );

    await eventually(() => {
      expect(mocco.callsTo('/results')).toHaveLength(1);
      expect(mocco.callsTo('/heartbeat').length).toBeGreaterThan(0);
      // It keeps polling after the first batch, at the server's pace.
      expect(mocco.callsTo('/lease').length).toBeGreaterThan(1);
    });
    await stop();

    const [firstLease] = mocco.callsTo('/lease');
    expect(firstLease).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      body: { agentVersion: '9.9.9', capacity: 4 },
    });
    expect(runCheck).toHaveBeenCalledWith(TCP_SPEC);
    expect(mocco.callsTo('/results')[0]?.body).toEqual({
      results: [
        {
          leaseId: lease.leaseId,
          monitorId: lease.monitorId,
          roundAt: lease.roundAt,
          outcome: 'ok',
          latencyMs: 12,
          timings: { connect: 3 },
        },
      ],
    });
    expect(mocco.callsTo('/heartbeat')[0]?.body).toMatchObject({ agentVersion: '9.9.9', inflight: expect.any(Number) });
  });

  it('runs a check at its round time, not when it was leased', async () => {
    const roundAt = new Date(Date.now() + 150);
    const startedAt: number[] = [];
    const { mocco, stop } = await setup(
      {
        '/lease': (_call, calls) =>
          calls.length === 1 ? { status: 200, body: { leases: [leaseOf({ roundAt })], pollAfterMs: 30 } } : empty,
      },
      async () => {
        startedAt.push(Date.now());
        return await Promise.resolve(ok);
      },
    );

    await eventually(() => {
      expect(mocco.callsTo('/results')).toHaveLength(1);
    });
    await stop();

    expect(startedAt[0]).toBeGreaterThanOrEqual(roundAt.getTime() - 5);
  });

  it('backs off after failed lease calls, doubling the wait, and recovers', async () => {
    const { mocco, log, stop } = await setup({
      '/lease': (_call, calls) => (calls.filter(call => call.path === '/lease').length <= 2 ? { status: 503 } : empty),
    });

    await eventually(() => {
      expect(mocco.callsTo('/lease').length).toBeGreaterThanOrEqual(4);
    });
    await stop();

    const at = mocco.callsTo('/lease').map(call => call.at);
    const gaps = at.slice(1).map((time, index) => time - (at[index] ?? time));
    // random() is 1, so the waits are exactly the base, then twice it, then the server's 30 ms.
    expect(gaps[0]).toBeGreaterThanOrEqual(35);
    expect(gaps[1]).toBeGreaterThanOrEqual(75);
    expect(log.warnings.filter(warning => warning === 'Lease failed; retrying')).toHaveLength(2);
  });

  it('retries posting results until Mocco takes them', async () => {
    let refusals = 1;
    const { mocco, stop } = await setup({
      '/lease': (_call, calls) =>
        calls.length === 1 ? { status: 200, body: { leases: [leaseOf()], pollAfterMs: 30 } } : empty,
      '/results': () => {
        refusals -= 1;
        return refusals >= 0
          ? { status: 500, body: undefined }
          : { status: 202, body: { accepted: 1, duplicates: 0, rejected: [] } };
      },
    });

    await eventually(() => {
      expect(mocco.callsTo('/results')).toHaveLength(2);
    });
    await stop();

    const [first, second] = mocco.callsTo('/results');
    expect(second?.body).toEqual(first?.body);
  });

  it('stops with ProbeAuthError when the token is refused', async () => {
    const { running } = await setup({ '/lease': () => ({ status: 401 }) });

    await expect(running).rejects.toBeInstanceOf(ProbeAuthError);
  });

  it('skips a lease of a kind it does not know and runs the rest', async () => {
    const known = leaseOf();
    const { mocco, log, stop } = await setup({
      '/lease': (_call, calls) =>
        calls.length === 1
          ? {
              status: 200,
              body: { leases: [leaseOf({ spec: { kind: 'dns', host: 'example.com' } }), known], pollAfterMs: 30 },
            }
          : empty,
    });

    await eventually(() => {
      expect(mocco.callsTo('/results')).toHaveLength(1);
    });
    await stop();

    expect(mocco.callsTo('/results')[0]?.body).toMatchObject({ results: [{ leaseId: known.leaseId }] });
    expect(log.warnings).toContain('Skipped leases of a monitor kind this agent does not know; update @mocco/probe');
  });

  it('on stop, drops checks that have not started, finishes running ones and posts their results', async () => {
    const running = leaseOf();
    const later = leaseOf({ roundAt: new Date(Date.now() + 60_000) });
    const gate = new EventTarget();
    const runCheck = vi.fn(async (spec: MonitorSpec) => {
      if (spec.kind === 'tcp' && spec.host === 'slow.internal') {
        await once(gate, 'release');
      }
      return ok;
    });
    const { mocco, stop } = await setup(
      {
        '/lease': (_call, calls) =>
          calls.length === 1
            ? {
                status: 200,
                body: {
                  leases: [{ ...running, spec: { ...TCP_SPEC, host: 'slow.internal' } }, later],
                  pollAfterMs: 30,
                },
              }
            : empty,
      },
      runCheck,
    );

    await eventually(() => {
      expect(runCheck).toHaveBeenCalledTimes(1);
    });
    const stopping = stop();
    gate.dispatchEvent(new Event('release'));
    await stopping;

    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(mocco.callsTo('/results')).toHaveLength(1);
    expect(mocco.callsTo('/results')[0]?.body).toMatchObject({ results: [{ leaseId: running.leaseId }] });
  });
});
