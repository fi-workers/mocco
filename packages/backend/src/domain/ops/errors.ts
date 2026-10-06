// Ops-domain errors. Nothing maps them to a transport: they fail the `stage0.canary`
// job, whose row and log line say what went wrong.

/** The canary source is missing, paused or not a GitHub source: an operator setup error. */
export class CanarySourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CanarySourceError';
  }
}

/** The ingest route did not accept the canary: a non-202 answer, or none at all. */
export class CanaryRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CanaryRejectedError';
  }
}
