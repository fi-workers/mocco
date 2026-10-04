// A TCP monitor: resolve under the address policy, connect to the checked address, and pass
// when the connection opens within the timeout (name resolution included).
import { connect, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

import { CheckOutcomes, type MonitorSpec } from '@mocco/common/status';

import { failedReport, roundTimings, wholeMs, type CheckContext, type CheckReport } from './check-report';
import { CheckTimeoutError } from './errors';
import { resolveTarget } from './resolve';

type TcpMonitorSpec = Extract<MonitorSpec, { kind: 'tcp' }>;

/** Opens a connection to `address:port`; the caller closes the socket. */
const openConnection = async (address: string, port: number, opened: (socket: Socket) => void): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: address, port });
    opened(socket);
    socket.once('connect', () => {
      resolve();
    });
    socket.once('error', reject);
    // Destroyed before it opened (the deadline passed): settle instead of hanging.
    socket.once('close', () => {
      reject(new Error(`Connection to ${address}:${port} closed before it opened`));
    });
  });
};

export async function runTcpCheck(spec: TcpMonitorSpec, context: CheckContext): Promise<CheckReport> {
  const started = performance.now();
  let socket: Socket | undefined;
  let timer: NodeJS.Timeout | undefined;
  let isSettled = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CheckTimeoutError(spec.timeoutMs));
    }, spec.timeoutMs);
  });
  const attempt = async (): Promise<CheckReport> => {
    const target = await resolveTarget(spec.host, context.resolver);
    const connectStarted = performance.now();
    await openConnection(target.address, spec.port, opened => {
      socket = opened;
      // The deadline passed while the name was resolving: don't leave this one open.
      if (isSettled) {
        opened.destroy();
      }
    });
    return {
      outcome: CheckOutcomes.ok,
      latencyMs: wholeMs(performance.now() - started),
      timings: roundTimings({ dns: target.dnsMs, connect: performance.now() - connectStarted }),
    };
  };
  try {
    return await Promise.race([attempt(), deadline]);
  } catch (error) {
    return failedReport(error, { latencyMs: wholeMs(performance.now() - started) });
  } finally {
    isSettled = true;
    clearTimeout(timer);
    socket?.destroy();
  }
}
