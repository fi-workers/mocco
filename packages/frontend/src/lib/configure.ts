import { Environments } from '@frontend/lib/environment';

import type { Environment } from '@frontend/lib/environment';

// Central client-side config reader — the one place that reads NEXT_PUBLIC_* env
// (the checkable app's Configure pattern). Grows to hold other public config
// (Sentry DSN, service URL, …) as they land; for now it resolves the Environment.

// Explicit override — accepts our own Environments values (case-insensitive).
function fromExplicit(value: string | undefined): Environment | undefined {
  switch (value?.toLowerCase()) {
    case 'local':
      return Environments.Local;
    case 'dev':
      return Environments.Dev;
    case 'prod':
      return Environments.Prod;
    default:
      return undefined;
  }
}

// Vercel's own env value (bridged to the client as NEXT_PUBLIC_VERCEL_ENV in next.config).
function fromVercel(vercelEnv: string | undefined): Environment | undefined {
  switch (vercelEnv) {
    case 'production':
      return Environments.Prod;
    case 'preview':
      return Environments.Dev;
    case 'development':
      return Environments.Local;
    default:
      return undefined;
  }
}

export class Configure {
  // Resolution order: an explicit NEXT_PUBLIC_ENVIRONMENT override wins, then
  // Vercel's environment, then a local default. Not Vercel-only.
  static readonly Environment: Environment =
    fromExplicit(process.env.NEXT_PUBLIC_ENVIRONMENT) ??
    fromVercel(process.env.NEXT_PUBLIC_VERCEL_ENV) ??
    Environments.Local;

  // Sentry DSN (empty → Sentry is a no-op). The DSN is public, so client and
  // server both use this one value (see instrumentation.ts).
  static readonly SentryDsn: string = process.env.NEXT_PUBLIC_SENTRY_DSN ?? '';

  // Debug/verification endpoints (/debug/*, /api/debug/*, debug tRPC) are gated
  // on this flag — off by default, opt-in per environment to re-verify Sentry etc.
  static readonly DebugEnabled: boolean = process.env.NEXT_PUBLIC_DEBUG === 'true';
}
