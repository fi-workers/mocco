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
  // The app's sitemap lists the customer guides, read from docs/customer at request time.
  outputFileTracingIncludes: { '/api/seo/sitemap': ['../../docs/customer/**/*.md'] },
  // Bridge Vercel's server-only VERCEL_ENV to the client so the EnvironmentRibbon
  // can mark preview/dev tabs. Empty off-Vercel (local) → the ribbon shows "development".
  // HELP_SITES_DOMAIN goes to the client too, so the console can link a help center's public site.
  env: {
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? '',
    NEXT_PUBLIC_HELP_SITES_DOMAIN: process.env.HELP_SITES_DOMAIN ?? '',
    NEXT_PUBLIC_HELP_CUSTOM_DOMAINS: process.env.HELP_CUSTOM_DOMAINS ?? '',
  },
  // The public API host (ADR 0017): with PUBLIC_API_DOMAIN set (e.g. api.mocco.club),
  // https://<that host>/v1/* is served by the ext app's /api/ext/v1 routes.
  rewrites: async () => {
    const apiHostname = hostnameOf(process.env.PUBLIC_API_DOMAIN);
    // Help centers (#96, ADR 0015): with HELP_SITES_DOMAIN set (e.g. help.mocco.club),
    // https://<site>.<that domain>/* is served by pages/_sites/<site>/*; a domain in
    // HELP_CUSTOM_DOMAINS (help.example.com=<site>) serves that site on the customer's own host.
    const helpHostname = hostnameOf(process.env.HELP_SITES_DOMAIN);
    const beforeFiles = [
      // Every host's robots.txt and sitemap.xml (#363) — the app's and each help center's —
      // come from one route that looks at the host, so they go before the help rewrites.
      { source: '/robots.txt', destination: '/api/seo/robots' },
      { source: '/sitemap.xml', destination: '/api/seo/sitemap' },
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
      // HELP_CUSTOM_DOMAINS: `help.example.com=example,docs.other.app=other` (domain = site slug).
      ...(process.env.HELP_CUSTOM_DOMAINS ?? '').split(',').flatMap(entry => {
        const [domain, site] = entry.split('=', 2).map(part => part.trim());
        const hostname = hostnameOf(domain).toLowerCase();
        if (hostname === '' || site === undefined || !/^[a-z0-9-]+$/u.test(site)) {
          return [];
        }
        return [
          {
            source: '/:path((?!_next/|api/|favicon).*)',
            has: [{ type: 'host' as const, value: `^${escape(hostname)}$` }],
            destination: `/_sites/${site}/:path`,
          },
        ];
      }),
    ];
    return { beforeFiles, afterFiles: [], fallback: [] };
  },
};
export default config;
