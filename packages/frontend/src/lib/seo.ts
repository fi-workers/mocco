// What the public pages tell search engines and link previews (#364): the app's own origin
// for absolute URLs, the default share image, and the schema.org JSON-LD each kind of page
// carries. Only types that still do something in 2026 — Organization and WebSite name the
// site, SoftwareApplication describes the product, BreadcrumbList and TechArticle describe a
// guide; no FAQPage or HowTo (Google retired those rich results in 2023).

/** The app's origin, e.g. https://www.mocco.club — from SERVICE_DOMAIN at build time. */
export function siteOrigin(): string {
  const host = process.env.NEXT_PUBLIC_SITE_HOST ?? '';
  if (host === '') {
    return 'http://localhost:3100';
  }
  // eslint-disable-next-line sonarjs/null-dereference -- an env string, never null
  return `${(host.split(':', 1)[0] ?? '').endsWith('localhost') ? 'http' : 'https'}://${host}`;
}

export const SITE_NAME = 'Mocco';

/** The share card used until per-page images are generated (OG images epic #368). */
export const DEFAULT_SHARE_IMAGE = {
  path: '/og/mocco.png',
  width: 1200,
  height: 630,
  alt: 'Mocco — everything your product needs, except the code. Release, Operate, Support.',
} as const;

type JsonLd = Record<string, unknown>;

export function organizationLd(origin: string): JsonLd {
  return {
    '@type': 'Organization',
    '@id': `${origin}/#organization`,
    name: SITE_NAME,
    url: `${origin}/`,
    logo: `${origin}/favicon/apple-touch-icon.png`,
    sameAs: ['https://github.com/fi-workers/mocco'],
  };
}

export function websiteLd(origin: string): JsonLd {
  return {
    '@type': 'WebSite',
    '@id': `${origin}/#website`,
    name: SITE_NAME,
    url: `${origin}/`,
    publisher: { '@id': `${origin}/#organization` },
  };
}

export function softwareApplicationLd(origin: string, description: string): JsonLd {
  return {
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    url: `${origin}/`,
    description,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Web',
    publisher: { '@id': `${origin}/#organization` },
  };
}

/** A trail of named pages; the last is the page itself. */
export function breadcrumbLd(origin: string, trail: readonly { name: string; path: string }[]): JsonLd {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: `${origin}${crumb.path}`,
    })),
  };
}

export function techArticleLd(
  origin: string,
  article: { path: string; title: string; description: string; updated: string | null },
): JsonLd {
  return {
    '@type': 'TechArticle',
    headline: article.title,
    description: article.description,
    url: `${origin}${article.path}`,
    ...(article.updated !== null && { dateModified: article.updated }),
    image: `${origin}${DEFAULT_SHARE_IMAGE.path}`,
    publisher: { '@id': `${origin}/#organization` },
    isPartOf: { '@id': `${origin}/#website` },
  };
}

/** One JSON-LD document holding several nodes; `<` is escaped so it can't close the script. */
export function jsonLdScript(nodes: readonly JsonLd[]): string {
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }).replaceAll('<', String.raw`\u003c`);
}
