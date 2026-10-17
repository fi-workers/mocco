import { appHostSiteOf, helpHostRoutes } from '@mocco/common/help-hosts';

import type { NextConfig } from 'next';

// Next matches `host` against the hostname (no port), as a regex.
const hostnameOf = (domain: string | undefined) => (domain ?? '').split(':', 1)[0] ?? '';
const escape = (hostname: string) => hostname.replaceAll('.', String.raw`\.`);
// A request that prefers Markdown (`Accept: text/markdown`) gets a page's Markdown instead of its HTML.
const acceptsMarkdown = { type: 'header' as const, key: 'accept', value: '.*text/markdown.*' };
// Help centers on their hosts (HELP_SITES_DOMAIN, HELP_CUSTOM_DOMAINS), and HELP_APP_HOST_SITE.
const helpEnv = {
  SERVICE_DOMAIN: process.env.SERVICE_DOMAIN,
  HELP_SITES_DOMAIN: process.env.HELP_SITES_DOMAIN,
  HELP_CUSTOM_DOMAINS: process.env.HELP_CUSTOM_DOMAINS,
  HELP_APP_HOST_SITE: process.env.HELP_APP_HOST_SITE,
};
const helpRoutes = helpHostRoutes(helpEnv);

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
  outputFileTracingIncludes: {
    '/api/seo/sitemap': ['../../docs/customer/**/*.md'],
    // OG images (ADR 0030) render with the fonts and the emoji pack kept beside the renderer.
    '/api/ext/**': [
      '../backend/src/domain/og/fonts/*.ttf',
      '../backend/src/domain/og/fonts/*.otf',
      '../backend/src/domain/og/emoji/*.br',
    ],
  },
  // The OG renderer (ADR 0030) loads from node_modules at runtime instead of being bundled: resvg is
  // a native addon, and satori reads its wasm (yoga, harfbuzz) from beside its own files.
  serverExternalPackages: ['@resvg/resvg-js', 'satori'],
  // Bundle the Pages Router's server dependencies (auth, tRPC, SEO, help routes) the way the App Router
  // already does, instead of loading them from node_modules at runtime. Unbundled, a cold function
  // resolved and compiled better-auth, drizzle, zod, Sentry and the rest file by file (the tRPC route
  // traced 2,320 files), as ESM that bytecode caching doesn't cover; bundled, it's ~400. This is
  // most of a cold first request's time (#419, docs/reference/env.md#function-region).
  // serverExternalPackages above, and Next's own default list (pg among it), stay external.
  bundlePagesRouterDependencies: true,
  // Bridge Vercel's server-only VERCEL_ENV to the client so the EnvironmentRibbon
  // can mark preview/dev tabs. Empty off-Vercel (local) → the ribbon shows "development".
  // HELP_SITES_DOMAIN goes to the client too, so the console can link a help center's public site.
  env: {
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? '',
    // The app's canonical host, for absolute URLs in public pages' metadata (lib/seo.ts): SERVICE_DOMAIN,
    // else the deployment's own host (a preview), as the backend resolves its origin.
    NEXT_PUBLIC_SITE_HOST: process.env.SERVICE_DOMAIN ?? process.env.VERCEL_URL ?? '',
    NEXT_PUBLIC_HELP_SITES_DOMAIN: process.env.HELP_SITES_DOMAIN ?? '',
    NEXT_PUBLIC_HELP_CUSTOM_DOMAINS: process.env.HELP_CUSTOM_DOMAINS ?? '',
    // The site whose board the app's own host serves, so the console links it there (empty when none).
    NEXT_PUBLIC_HELP_APP_HOST_SITE: appHostSiteOf(helpEnv) ?? '',
  },
  // The public API host (ADR 0017): with PUBLIC_API_DOMAIN set (e.g. api.mocco.club),
  // https://<that host>/v1/* is served by the ext app's /api/ext/v1 routes.
  // The same URL answers HTML or Markdown depending on Accept, so caches must key on it.
  headers: async () => [
    { source: '/docs/:set/:page', headers: [{ key: 'Vary', value: 'Accept' }] },
    { source: '/:locale/articles/:ref', headers: [{ key: 'Vary', value: 'Accept' }] },
  ],
  // A site mounted on the app host (HELP_APP_HOST_SITE): its own hosts send /feedback/* there (308).
  redirects: async () => helpRoutes.redirects,
  rewrites: async () => {
    const apiHostname = hostnameOf(process.env.PUBLIC_API_DOMAIN);
    const beforeFiles = [
      // Every host's robots.txt and sitemap.xml (#363) — the app's and each help center's —
      // come from one route that looks at the host, so they go before the help rewrites.
      // Signed OG images (ADR 0030), on every host so a help center's cards come from its domain.
      { source: '/og/v1/:path*', destination: '/api/ext/og/v1/:path*' },
      { source: '/robots.txt', destination: '/api/seo/robots' },
      { source: '/sitemap.xml', destination: '/api/seo/sitemap' },
      // A public board's changelog feed (#176), on its help site's host or, for HELP_APP_HOST_SITE, the
      // app's host (others answer 404).
      { source: '/feedback/:board/changelog.rss', destination: '/api/seo/changelog?board=:board' },
      { source: '/indexnow.txt', destination: '/api/seo/indexnow' },
      // Agents (#366): llms.txt, llms-full.txt and every page's Markdown — by a `.md` URL, or
      // the page's own URL asked for with `Accept: text/markdown`. The `:locale` forms only
      // answer on a help center's host.
      ...(['llms', 'llms-full'] as const).flatMap(file => [
        { source: `/${file}.txt`, destination: `/api/seo/agents?file=${file}` },
        { source: `/:locale/${file}.txt`, destination: `/api/seo/agents?file=${file}&locale=:locale` },
      ]),
      { source: '/docs/:set/:page.md', destination: '/api/seo/agents?file=guide&path=/docs/:set/:page' },
      {
        source: '/docs/:set/:page',
        has: [acceptsMarkdown],
        destination: '/api/seo/agents?file=guide&path=/docs/:set/:page',
      },
      { source: '/:locale/articles/:ref.md', destination: '/api/seo/agents?file=article&locale=:locale&path=:ref' },
      {
        source: '/:locale/articles/:ref',
        has: [acceptsMarkdown],
        destination: '/api/seo/agents?file=article&locale=:locale&path=:ref',
      },
      ...(apiHostname === ''
        ? []
        : [
            {
              source: '/v1/:path*',
              has: [{ type: 'host' as const, value: `^${escape(apiHostname)}$` }],
              destination: '/api/ext/v1/:path*',
            },
          ]),
      // Help centers (#96, ADR 0015), and the one site whose /feedback pages the app's own host
      // serves (HELP_APP_HOST_SITE): see @mocco/common/help-hosts.
      ...helpRoutes.rewrites,
    ];
    return { beforeFiles, afterFiles: [], fallback: [] };
  },
};
export default config;
