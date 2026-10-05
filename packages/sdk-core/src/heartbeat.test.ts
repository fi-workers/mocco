// heartbeat(token).wrap(fn) against a fake Mocco: a local HTTP server that records the pings it
// gets and answers what each test sets.
import { createServer } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { heartbeat } from './heartbeat';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const throwingHandler = () => {
  throw new Error('handler');
};

const TOKEN = 'mhb_0123456789012345678901234567890123456789abc';

describe('heartbeat', () => {
  let server: Server;
  let baseUrl: string;
  let pings: string[];
  let answer: (path: string) => number;

  beforeEach(async () => {
    pings = [];
    answer = () => 200;
    server = createServer((request, response) => {
      const path = request.url ?? '';
      pings.push(`${request.method ?? ''} ${path}`);
      response.writeHead(answer(path), { 'content-type': 'text/plain' }).end('OK');
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(port)}/v1/`;
  });
  afterEach(async () => {
    await new Promise(resolve => {
      server.close(resolve);
    });
  });

  it('pings /start, runs the job, then pings success and returns its result', async () => {
    const result = await heartbeat(TOKEN, { baseUrl }).wrap(async () => {
      expect(pings).toEqual([`POST /v1/ping/${TOKEN}/start`]);
      return await Promise.resolve(42);
    });
    expect(result).toBe(42);
    expect(pings).toEqual([`POST /v1/ping/${TOKEN}/start`, `POST /v1/ping/${TOKEN}`]);
  });

  it('pings /fail when the job throws, and rethrows the job’s own error', async () => {
    const boom = new Error('disk full');
    await expect(
      heartbeat(TOKEN, { baseUrl }).wrap(() => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(pings).toEqual([`POST /v1/ping/${TOKEN}/start`, `POST /v1/ping/${TOKEN}/fail`]);
  });

  it('sends an exit code', async () => {
    expect(await heartbeat(TOKEN, { baseUrl }).exitCode(3)).toBe(true);
    expect(pings).toEqual([`POST /v1/ping/${TOKEN}/3`]);
  });

  it('never throws its own failures into the job: an unreachable server or a refusal is reported and the job runs', async () => {
    const onError = vi.fn();
    const unreachable = 'http://127.0.0.1:9/v1';
    const ran = vi.fn(() => 'done');
    expect(await heartbeat(TOKEN, { baseUrl: unreachable, onError, retryDelayMs: 0 }).wrap(ran)).toBe('done');
    expect(ran).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls.map(([, ping]) => ping as string)).toEqual(['start', 'success']);

    answer = () => 404;
    const refused = vi.fn();
    expect(await heartbeat(TOKEN, { baseUrl, onError: refused }).success()).toBe(false);
    // A 404 is a wrong token: not retried.
    expect(pings).toEqual([`POST /v1/ping/${TOKEN}`]);
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }), 'success');
  });

  it('retries once on a 5xx or 429, and keeps going when a handler throws', async () => {
    let calls = 0;
    answer = () => {
      calls += 1;
      return calls === 1 ? 503 : 200;
    };
    expect(await heartbeat(TOKEN, { baseUrl, retryDelayMs: 0 }).success()).toBe(true);
    expect(pings).toHaveLength(2);

    answer = () => 500;
    expect(await heartbeat(TOKEN, { baseUrl, retryDelayMs: 0, onError: throwingHandler }).fail()).toBe(false);
  });
});
