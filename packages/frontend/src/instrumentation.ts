import { Monitoring } from './lib/monitoring';

// Server-side monitoring init (Next auto-loads this file). An empty DSN makes it
// a no-op, so builds and local dev without SENTRY_DSN are unaffected.
export function register(): void {
  Monitoring.init(process.env.SENTRY_DSN, process.env.VERCEL_ENV ?? 'development');
}

// Report errors thrown during server request handling (Next's onRequestError hook).
export const { onRequestError } = Monitoring;
