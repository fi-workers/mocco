import type { NextConfig } from 'next';

const config: NextConfig = {
  // Transpile the internal workspace packages: @mocco/backend and the
  // @mocco/common schemas it pulls in across the package boundary (a transitive
  // dep — the app never imports @mocco/common directly).
  transpilePackages: ['@mocco/backend', '@mocco/common'],
  // React Compiler: automatic memoization — no manual useMemo/useCallback/React.memo.
  // Greenfield projects get the best ROI; our strict react-hooks lint is the prerequisite.
  reactCompiler: true,
  // Bridge Vercel's server-only VERCEL_ENV to the client so the EnvironmentRibbon
  // can mark preview/dev tabs. Empty off-Vercel (local) → the ribbon shows "development".
  env: { NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? '' },
  // The public API host (ADR 0017): with PUBLIC_API_DOMAIN set (e.g. api.mocco.club),
  // https://<that host>/v1/* is served by the ext app's /api/ext/v1 routes.
  rewrites: async () => {
    // Next matches `host` against the hostname (no port), as a regex.
    const apiHostname = (process.env.PUBLIC_API_DOMAIN ?? '').split(':', 1)[0] ?? '';
    if (apiHostname === '') {
      return [];
    }
    const escaped = apiHostname.replaceAll('.', String.raw`\.`);
    const pattern = `^${escaped}$`;
    return {
      beforeFiles: [
        { source: '/v1/:path*', has: [{ type: 'host', value: pattern }], destination: '/api/ext/v1/:path*' },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};
export default config;
