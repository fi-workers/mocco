import { Configure } from './lib/configure';
import { Monitoring } from './lib/monitoring';

// Server-side monitoring init (Next auto-loads this file). The DSN is not secret
// (it ships in the client bundle), so server and client share the one value via
// Configure — no separate SENTRY_DSN needed. Empty DSN → no-op.
export function register(): void {
  Monitoring.init(Configure.SentryDsn, Configure.Environment);
}

// Report errors thrown during server request handling (Next's onRequestError hook).
export const { onRequestError } = Monitoring;
