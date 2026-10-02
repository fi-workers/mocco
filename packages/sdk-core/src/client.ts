import { MoccoError, MoccoNetworkError } from './errors';
import { checkKey } from './keys';
import { backoffMs, isRetryableStatus, serverWaitSeconds } from './retry';

import type { KeyKind } from './keys';

/** Mocco's public API. Self-hosted or custom-domain installs pass their own `baseUrl`. */
export const DEFAULT_BASE_URL = 'https://api.mocco.club/v1';

export interface MoccoClientOptions {
  /** A publishable (`mk_pub_…`) or secret (`mk_sec_…`) key. */
  key: string;
  baseUrl?: string;
  /** Retries for rate limits, 5xx and network errors on safe requests (default 2). */
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to "is there a `window` and `document`". */
  isBrowser?: boolean;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Makes a POST safe to retry (Mocco dedupes on it). */
  idempotencyKey?: string;
}

/** What `GET /v1/whoami` answers: the project and scopes a key speaks for. */
export interface WhoAmI {
  projectId: string;
  kind: KeyKind;
  scopes: string[];
}

const sleepFor = async (ms: number) => {
  await new Promise(resolve => {
    setTimeout(resolve, ms);
  });
};

const isBrowserEnvironment = () => 'window' in globalThis && 'document' in globalThis;

/** `https://x/v1/` → `https://x/v1` (no regex: the base URL is caller input). */
export function withoutTrailingSlashes(url: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- url is a string, never null
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') {
    end -= 1;
  }
  return url.slice(0, end);
}

/** Parse a problem+json body; fall back to the status line. */
async function problemOf(response: Response): Promise<{ type?: string; title?: string; detail?: string }> {
  try {
    return (await response.json()) as { type?: string; title?: string; detail?: string };
  } catch {
    return { title: `HTTP ${response.status}` };
  }
}

/**
 * The /v1 client every Mocco SDK builds on: it sends the key, retries what is safe to
 * retry (GETs, and POSTs with an idempotency key) on 429 and 5xx with the server's wait
 * hint or backoff, and turns problem+json refusals into `MoccoError`.
 */
export class MoccoClient {
  private readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;

  private readonly sleep: (ms: number) => Promise<void>;

  readonly keyKind: KeyKind;

  constructor(private readonly options: MoccoClientOptions) {
    this.keyKind = checkKey(options.key, { isBrowser: options.isBrowser ?? isBrowserEnvironment() });
    this.baseUrl = withoutTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.sleep = options.sleep ?? sleepFor;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const isRetryable = method === 'GET' || opts.idempotencyKey !== undefined;
    const maxRetries = isRetryable ? (this.options.maxRetries ?? 2) : 0;
    const attempt = async (count: number): Promise<T> => {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.options.key}`,
            accept: 'application/json',
            ...(opts.body !== undefined && { 'content-type': 'application/json' }),
            ...(opts.idempotencyKey !== undefined && { 'idempotency-key': opts.idempotencyKey }),
            ...opts.headers,
          },
          ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
        });
      } catch (error) {
        if (count < maxRetries) {
          await this.sleep(backoffMs(count + 1, null));
          return await attempt(count + 1);
        }
        throw new MoccoNetworkError(`Couldn't reach Mocco at ${this.baseUrl}`, { cause: error });
      }
      if (response.ok) {
        return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
      }
      if (isRetryableStatus(response.status) && count < maxRetries) {
        await this.sleep(backoffMs(count + 1, serverWaitSeconds(response.headers)));
        return await attempt(count + 1);
      }
      throw new MoccoError(response.status, await problemOf(response));
    };
    return await attempt(0);
  }

  /** Which project and scopes this key speaks for — a quick configuration check. */
  async whoami(): Promise<WhoAmI> {
    return await this.request<WhoAmI>('GET', '/whoami');
  }
}
