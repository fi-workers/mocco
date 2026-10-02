import type { NextConfig } from 'next';

// Next matches `host` against the hostname (no port), as a regex.
const hostnameOf = (domain: string | undefined) => (domain ?? '').split(':', 1)[0] ?? '';
const escape = (hostname: string) => hostname.replaceAll('.', String.raw`\.`);

const config: NextConfig = {
  // `next dev` serves local help centers at <site>.help.localhost (HELP_SITES_DOMAIN).
  allowedDevOrigins: ['*.help.localhost'],
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
    const apiHostname = hostnameOf(process.env.PUBLIC_API_DOMAIN);
    // Help centers (#96, ADR 0025): with HELP_SITES_DOMAIN set (e.g. help.mocco.club),
    // https://<site>.<that domain>/* is served by pages/_sites/<site>/*.
    const helpHostname = hostnameOf(process.env.HELP_SITES_DOMAIN);
    const beforeFiles = [
      ...(apiHostname === ''
        ? []
        : [
            {
              source: '/v1/:path*',
              has: [{ type: 'host' as const, value: `^${escape(apiHostname)}$` }],
              destination: '/api/ext/v1/:path*',
            },
          ]),
      ...(helpHostname === ''
        ? []
        : [
            {
              // Everything but Next's own assets and the API routes.
              source: '/:path((?!_next/|api/|favicon).*)',
              has: [{ type: 'host' as const, value: String.raw`^(?<site>[a-z0-9-]+)\.${escape(helpHostname)}$` }],
              destination: '/_sites/:site/:path',
            },
          ]),
    ];
    return { beforeFiles, afterFiles: [], fallback: [] };
  },
};
export default config;
