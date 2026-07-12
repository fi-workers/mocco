import * as Sentry from '@sentry/nextjs';

// The ONLY file that imports the monitoring vendor (Sentry). Everything else
// reports through this neutral surface, so swapping the vendor — or dropping
// Next — touches this file alone (AGENTS.md vendor isolation). Env is read at the
// call sites (instrumentation files) and passed in, keeping this vendor-only.
export const Monitoring = {
  /** Initialize the SDK. An empty DSN makes it a no-op. */
  init(dsn: string | undefined, environment: string): void {
    Sentry.init({ dsn, environment, tracesSampleRate: 0 });
  },

  /** Report an error, with optional structured context. */
  captureException(error: unknown, context?: Record<string, unknown>): void {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  },

  /** Next's server request-error hook (wire from instrumentation.ts). */
  onRequestError: Sentry.captureRequestError,
};
