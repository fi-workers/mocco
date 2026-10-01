/** Statuses worth retrying: rate limited, or the service briefly unavailable. */
const RETRYABLE = new Set([429, 502, 503, 504]);

export const isRetryableStatus = (status: number) => RETRYABLE.has(status);

/**
 * How long to wait before attempt `attempt` (1 = the first retry): what the server asked
 * for (`Retry-After` or `RateLimit-Reset`, in seconds) when it said, otherwise
 * exponential backoff from 250 ms with jitter, capped at 8 s.
 */
export function backoffMs(attempt: number, serverSeconds: number | null, random: () => number = Math.random): number {
  if (serverSeconds !== null && Number.isFinite(serverSeconds) && serverSeconds >= 0) {
    return Math.min(serverSeconds * 1000, 60_000);
  }
  const base = Math.min(250 * 2 ** (attempt - 1), 8000);
  return Math.round(base / 2 + random() * (base / 2));
}

/** The server's wait hint in seconds, from `Retry-After` or `RateLimit-Reset`. */
export function serverWaitSeconds(headers: Headers): number | null {
  const value = headers.get('retry-after') ?? headers.get('ratelimit-reset');
  if (value === null) {
    return null;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : null;
}
