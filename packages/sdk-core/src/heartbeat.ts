// Heartbeat pings (#153): a job tells Mocco it started, finished or failed, at
// `/v1/ping/{token}[/start|/fail|/{exitCode}]`. The token in the path is the only credential, so
// no API key is sent. A ping never throws: monitoring must not break the job it watches, so a
// network error, a timeout or a refusal is reported to `onError` (a console warning by default)
// and the ping resolves to false.
import { DEFAULT_BASE_URL, withoutTrailingSlashes } from './client';
import { HeartbeatPingError } from './errors';

export interface HeartbeatOptions {
  /** Mocco's `/v1` base; self-hosted installs pass theirs (e.g. `https://mocco.example.com/api/ext/v1`). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** How long one attempt may take. Default 10 seconds. */
  timeoutMs?: number;
  /** How long to wait before the one retry. Default 1 second. */
  retryDelayMs?: number;
  /** Called when a ping couldn't be delivered; the default logs a warning. */
  onError?: (error: unknown, ping: HeartbeatPingKind) => void;
}

/** Which ping: the job finished (`success`), started, failed, or exited with a code. */
export type HeartbeatPingKind = 'success' | 'start' | 'fail' | `exit:${string}`;

const DEFAULT_TIMEOUT_MS = 10_000;
/** A failed attempt (network error, timeout, 429 or 5xx) is tried once more after this long. */
const DEFAULT_RETRY_DELAY_MS = 1000;

const pathOf = (ping: HeartbeatPingKind): string => {
  if (ping === 'success') {
    return '';
  }
  return ping.startsWith('exit:') ? `/${ping.slice('exit:'.length)}` : `/${ping}`;
};

const isRetryable = (status: number) => status === 429 || status >= 500;

const delay = async (ms: number) =>
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });

/** One heartbeat monitor's pings. */
export class Heartbeat {
  private readonly url: string;

  private readonly fetchImpl: typeof fetch;

  private readonly timeoutMs: number;

  private readonly retryDelayMs: number;

  private readonly onError: (error: unknown, ping: HeartbeatPingKind) => void;

  constructor(token: string, options: HeartbeatOptions = {}) {
    this.url = `${withoutTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL)}/ping/${encodeURIComponent(token)}`;
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.onError =
      options.onError ??
      ((error, ping) => {
        console.warn(`[mocco] heartbeat ${ping} ping failed; the job continues`, error);
      });
  }

  private async attempt(ping: HeartbeatPingKind): Promise<HeartbeatPingError | undefined> {
    try {
      const response = await this.fetchImpl(`${this.url}${pathOf(ping)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.ok) {
        return undefined;
      }
      return new HeartbeatPingError(
        response.status === 404
          ? 'Mocco has no heartbeat with this token (it may have been replaced)'
          : `Mocco answered ${String(response.status)}`,
        response.status,
      );
    } catch (error) {
      return new HeartbeatPingError("Couldn't reach Mocco", undefined, { cause: error });
    }
  }

  /** Send one ping, retried once on a network error, a timeout, 429 or 5xx. Never throws. */
  async send(ping: HeartbeatPingKind): Promise<boolean> {
    let failure = await this.attempt(ping);
    if (failure !== undefined && (failure.status === undefined || isRetryable(failure.status))) {
      await delay(this.retryDelayMs);
      failure = await this.attempt(ping);
    }
    if (failure === undefined) {
      return true;
    }
    try {
      this.onError(failure, ping);
    } catch {
      // A throwing handler must not break the job either.
    }
    return false;
  }

  /** The job finished. */
  async success(): Promise<boolean> {
    return await this.send('success');
  }

  /** The job started: Mocco shows the run time on the next finish. */
  async start(): Promise<boolean> {
    return await this.send('start');
  }

  /** The job failed: the monitor is down at once. */
  async fail(): Promise<boolean> {
    return await this.send('fail');
  }

  /** The job exited with `code` (0 to 255): 0 is a success, anything else a failure. */
  async exitCode(code: number): Promise<boolean> {
    return await this.send(`exit:${String(code)}`);
  }

  /**
   * Run `fn` between a `start` ping and a success ping, or a `fail` ping when it throws, and
   * return its result. `fn`'s own error is rethrown after the `fail` ping; a ping that can't be
   * delivered is reported to `onError` and never reaches the caller.
   */
  async wrap<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.start();
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      await this.fail();
      throw error;
    }
    await this.success();
    return result;
  }
}

/** The pings of the heartbeat monitor whose token is `token` (`mhb_…`). */
export function heartbeat(token: string, options?: HeartbeatOptions): Heartbeat {
  return new Heartbeat(token, options);
}
