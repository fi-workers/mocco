// sitemap.xml bodies (#363): a <urlset> where each page can list its language versions as
// xhtml:link alternates (Google's hreflang-in-sitemaps form). Every version of a page lists
// all of them, itself included, so the annotations are reciprocal; x-default is the source.

export interface SitemapPage {
  /** Absolute URL. */
  loc: string;
  lastModified?: Date | null;
  alternates?: readonly { hreflang: string; href: string }[];
}

const escapeXml = (text: string) =>
  // eslint-disable-next-line sonarjs/null-dereference -- a string, never null
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export function sitemapXml(pages: readonly SitemapPage[]): string {
  const urls = pages.map(page =>
    [
      '  <url>',
      `    <loc>${escapeXml(page.loc)}</loc>`,
      ...(page.lastModified === undefined || page.lastModified === null
        ? []
        : [`    <lastmod>${page.lastModified.toISOString()}</lastmod>`]),
      ...(page.alternates ?? []).map(
        alternate =>
          `    <xhtml:link rel="alternate" hreflang="${escapeXml(alternate.hreflang)}" href="${escapeXml(alternate.href)}"/>`,
      ),
      '  </url>',
    ].join('\n'),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

/**
 * One sitemap entry per language version of each page, each listing every version plus
 * x-default (the `defaultLocale` version). A page in one language gets no alternates.
 */
export function withLanguageVersions(
  origin: string,
  groups: readonly (readonly { locale: string; path: string; lastModified?: Date | null }[])[],
  defaultLocale: string,
): SitemapPage[] {
  return groups.flatMap(versions => {
    const fallback = versions.find(version => version.locale === defaultLocale);
    const alternates =
      versions.length < 2
        ? []
        : [
            ...versions.map(version => ({ hreflang: version.locale, href: `${origin}${version.path}` })),
            ...(fallback === undefined ? [] : [{ hreflang: 'x-default', href: `${origin}${fallback.path}` }]),
          ];
    return versions.map(version => ({
      loc: `${origin}${version.path}`,
      lastModified: version.lastModified ?? null,
      alternates,
    }));
  });
}
