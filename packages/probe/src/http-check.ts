// An HTTP monitor, over undici (the only file that imports it). Each check gets its own agent
// whose connect hook resolves the host under the location's address policy and opens the
// socket to exactly the address it checked, so every redirect hop and every connection is
// held to the policy and nothing resolves the name a second time (ADR 0027 §7).
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

import { CheckErrorKinds, CheckOutcomes, KeywordModes, type MonitorSpec } from '@mocco/common/status';
import { Agent, type buildConnector, type Dispatcher } from 'undici';

import { failedReport, roundTimings, wholeMs, type CheckContext, type CheckReport, type Timings } from './check-report';
import { CheckTimeoutError, truncateDetail } from './errors';
import { bareHost, resolveTarget } from './resolve';

type HttpMonitorSpec = Extract<MonitorSpec, { kind: 'http' }>;

export const HttpCheckLimits = {
  /** Redirects followed before the check fails. */
  maxRedirects: 5,
  /** A keyword is looked for in this much of the body, no more. */
  keywordWindowBytes: 1024 * 1024,
} as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DAY_MS = 86_400_000;
const HTTPS = 'https:';

/** What the connect hook saw for one connection. */
interface Connection {
  timings: Timings;
  readyAt: number;
  certificateExpiresAt?: Date;
}

/** A check failure that isn't an error of the network: a status, a keyword, a redirect. */
class CheckFailure extends Error {
  constructor(
    readonly report: CheckReport,
    message: string,
  ) {
    super(message);
    this.name = 'CheckFailure';
  }
}

const connectionKey = (protocol: string, host: string): string => `${protocol}//${bareHost(host)}`;

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** Opens a socket to the address `resolveTarget` checked, and records what the connection took. */
const openPinned = async (
  options: buildConnector.Options,
  context: CheckContext,
  sockets: Set<Socket>,
): Promise<{ socket: Socket; connection: Connection }> => {
  const target = await resolveTarget(options.hostname, context.resolver);
  const host = bareHost(options.hostname);
  const isSecure = options.protocol === HTTPS;
  const port = Number(options.port) || (isSecure ? 443 : 80);
  const started = performance.now();
  const timings: Timings = { dns: target.dnsMs };
  const socket: Socket = isSecure
    ? tlsConnect({ host: target.address, port, servername: isIP(host) === 0 ? host : undefined })
    : netConnect({ host: target.address, port });
  sockets.add(socket);
  return await new Promise((resolve, reject) => {
    let tcpOpenedAt = started;
    socket.once('error', reject);
    socket.once('connect', () => {
      tcpOpenedAt = performance.now();
      timings.connect = tcpOpenedAt - started;
    });
    socket.once(isSecure ? 'secureConnect' : 'connect', () => {
      socket.off('error', reject);
      const readyAt = performance.now();
      const connection: Connection = { timings, readyAt };
      if (isSecure) {
        timings.tls = readyAt - tcpOpenedAt;
        const expiresAt = new Date((socket as TLSSocket).getPeerCertificate().valid_to);
        if (!Number.isNaN(expiresAt.getTime())) {
          connection.certificateExpiresAt = expiresAt;
        }
      }
      resolve({ socket, connection });
    });
  });
};

/**
 * undici's connect hook: resolve under the policy, then connect to the checked address. TLS
 * still verifies the certificate against the hostname (`servername`), not the address.
 */
const pinnedConnector =
  (context: CheckContext, connections: Map<string, Connection>, sockets: Set<Socket>): buildConnector.connector =>
  (options, callback) => {
    const attempt = async () => {
      try {
        const { socket, connection } = await openPinned(options, context, sockets);
        connections.set(connectionKey(options.protocol, options.hostname), connection);
        callback(null, socket);
      } catch (error) {
        callback(toError(error), null);
      }
    };
    // eslint-disable-next-line no-void -- undici's hook takes a callback; attempt() never rejects
    void attempt();
  };

/** The first `limit` bytes of a body, as text; stops reading once it has them. */
const readHead = async (body: Dispatcher.ResponseData['body'], limit: number): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    body.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= limit) {
        resolve(Buffer.concat(chunks).subarray(0, limit).toString('utf8'));
        body.destroy();
      }
    });
    body.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    body.once('error', reject);
  });

/** The body text a keyword is looked for in; read and discarded when there is no keyword. */
const bodyText = async (spec: HttpMonitorSpec, body: Dispatcher.ResponseData['body']): Promise<string> => {
  if (spec.keyword === undefined) {
    await body.dump();
    return '';
  }
  return await readHead(body, HttpCheckLimits.keywordWindowBytes);
};

const headerOf = (headers: Dispatcher.ResponseData['headers'], name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const isExpectedStatus = (spec: HttpMonitorSpec, statusCode: number): boolean =>
  spec.expectedStatus.length === 0 ? statusCode >= 200 && statusCode < 300 : spec.expectedStatus.includes(statusCode);

/** Why the keyword rule failed, if it did. */
const keywordProblem = (spec: HttpMonitorSpec, text: string): string | undefined => {
  if (spec.keyword === undefined) {
    return undefined;
  }
  // eslint-disable-next-line sonarjs/null-dereference -- text is a string, never null
  const isFound = text.includes(spec.keyword);
  if (spec.keywordMode === KeywordModes.contains && !isFound) {
    return `"${spec.keyword}" not found in the first ${HttpCheckLimits.keywordWindowBytes} bytes`;
  }
  if (spec.keywordMode === KeywordModes.absent && isFound) {
    return `"${spec.keyword}" found in the response`;
  }
  return undefined;
};

interface FinalResponse {
  response: Dispatcher.ResponseData;
  url: URL;
  headersAt: number;
  hopStartedAt: number;
}

export async function runHttpCheck(spec: HttpMonitorSpec, context: CheckContext): Promise<CheckReport> {
  const started = performance.now();
  const connections = new Map<string, Connection>();
  const sockets = new Set<Socket>();
  const dispatcher = new Agent({
    connect: pinnedConnector(context, connections, sockets),
    headersTimeout: spec.timeoutMs,
    bodyTimeout: spec.timeoutMs,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new CheckTimeoutError(spec.timeoutMs));
  }, spec.timeoutMs);

  /** Sends one request, following redirects itself so each hop's target goes through the hook. */
  const send = async (
    url: URL,
    method: Dispatcher.HttpMethod,
    body: string | undefined,
    hops: number,
  ): Promise<FinalResponse> => {
    const hopStartedAt = performance.now();
    const response = await dispatcher.request({
      origin: url.origin,
      path: `${url.pathname}${url.search}`,
      method,
      body,
      headers: { 'user-agent': context.userAgent, accept: '*/*' },
      signal: controller.signal,
    });
    const headersAt = performance.now();
    const location = headerOf(response.headers, 'location');
    if (!spec.followRedirects || !REDIRECT_STATUSES.has(response.statusCode) || location === undefined) {
      return { response, url, headersAt, hopStartedAt };
    }
    await response.body.dump();
    const failure = (detail: string) =>
      new CheckFailure(
        {
          outcome: CheckOutcomes.fail,
          errorKind: CheckErrorKinds.status,
          statusCode: response.statusCode,
          detail: truncateDetail(detail),
        },
        detail,
      );
    if (hops >= HttpCheckLimits.maxRedirects) {
      throw failure(`More than ${HttpCheckLimits.maxRedirects} redirects`);
    }
    const next = new URL(location, url);
    if (next.protocol !== 'http:' && next.protocol !== HTTPS) {
      throw failure(`Redirect to an unsupported scheme: ${next.protocol}`);
    }
    // 303, and 301/302 after a POST, continue as a GET without the body (as browsers do).
    const isNowGet = response.statusCode === 303 || (method === 'POST' && response.statusCode <= 302);
    return await send(next, isNowGet ? 'GET' : method, isNowGet ? undefined : body, hops + 1);
  };

  try {
    const { response, url, headersAt, hopStartedAt } = await send(new URL(spec.url), spec.method, spec.body, 0);
    const latencyMs = wholeMs(headersAt - started);
    const connection = connections.get(connectionKey(url.protocol, url.hostname));
    const timings = roundTimings({
      ...connection?.timings,
      ttfb: headersAt - Math.max(hopStartedAt, connection?.readyAt ?? hopStartedAt),
    });
    const tlsExpiresAt = connection?.certificateExpiresAt;
    const measured = { statusCode: response.statusCode, latencyMs, timings, tlsExpiresAt };

    const text = await bodyText(spec, response.body);

    if (!isExpectedStatus(spec, response.statusCode)) {
      return {
        outcome: CheckOutcomes.fail,
        errorKind: CheckErrorKinds.status,
        detail: `HTTP ${response.statusCode}`,
        ...measured,
      };
    }
    const keyword = keywordProblem(spec, text);
    if (keyword !== undefined) {
      return {
        outcome: CheckOutcomes.fail,
        errorKind: CheckErrorKinds.keyword,
        detail: truncateDetail(keyword),
        ...measured,
      };
    }
    if (spec.latencyThresholdMs !== undefined && latencyMs > spec.latencyThresholdMs) {
      // Still a pass: the evaluator turns a quorum of slow passes into `degraded`.
      const detail = `${latencyMs} ms is over the ${spec.latencyThresholdMs} ms threshold`;
      return { outcome: CheckOutcomes.ok, errorKind: CheckErrorKinds.latency, detail, ...measured };
    }
    const daysLeft =
      tlsExpiresAt === undefined ? undefined : Math.floor((tlsExpiresAt.getTime() - context.now().getTime()) / DAY_MS);
    if (spec.tlsWarnDays !== undefined && daysLeft !== undefined && daysLeft < spec.tlsWarnDays) {
      return { outcome: CheckOutcomes.ok, detail: `TLS certificate expires in ${daysLeft} days`, ...measured };
    }
    return { outcome: CheckOutcomes.ok, ...measured };
  } catch (error) {
    if (error instanceof CheckFailure) {
      return { ...error.report, latencyMs: wholeMs(performance.now() - started) };
    }
    const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
    return failedReport(reason, { latencyMs: wholeMs(performance.now() - started) });
  } finally {
    clearTimeout(timer);
    sockets.forEach(socket => {
      socket.destroy();
    });
    try {
      await dispatcher.destroy();
    } catch {
      // Already closed: nothing to release.
    }
  }
}
