/** A refusal from Mocco: the RFC 9457 problem the API answered with. */
export class MoccoError extends Error {
  /** The stable code at the end of the problem `type` (e.g. `invalid_key`, `rate_limited`). */
  readonly code: string;

  constructor(
    readonly status: number,
    readonly problem: { type?: string; title?: string; detail?: string },
  ) {
    super(problem.detail ?? problem.title ?? `Mocco answered ${status}`);
    this.name = 'MoccoError';
    this.code = problem.type?.split('/').at(-1) ?? 'unknown';
  }
}

/** Mocco couldn't be reached (after the retries). */
export class MoccoNetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MoccoNetworkError';
  }
}

/** A heartbeat ping that couldn't be delivered: unreachable (`status` undefined) or refused. */
export class HeartbeatPingError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HeartbeatPingError';
  }
}

/** A key that must not be used where it is (a secret key in a browser, a malformed key). */
export class MoccoKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoccoKeyError';
  }
}
