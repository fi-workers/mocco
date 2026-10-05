// The search and share metadata of a public page (#364): title, description, canonical URL,
// Open Graph and Twitter card tags, and optional JSON-LD. Every tag has a `key`, so a page's
// values replace the app-wide defaults in _app.tsx instead of adding to them.
import Head from 'next/head';

import { DEFAULT_SHARE_IMAGE, jsonLdScript, SITE_NAME } from '@frontend/lib/seo';

interface Props {
  title: string;
  description: string;
  /** Absolute canonical URL of this page. */
  url: string;
  /** Origin the share image is served from. */
  origin: string;
  type?: 'website' | 'article';
  siteName?: string;
  /** BCP 47 language of the page, e.g. `en` or `ko`. */
  locale?: string;
  /** The page in other languages, itself included, plus `x-default` — absolute URLs. */
  alternates?: readonly { hreflang: string; href: string }[];
  /** False leaves out the share image (a customer's help site doesn't share Mocco's). */
  withImage?: boolean;
  noindex?: boolean;
  jsonLd?: readonly Record<string, unknown>[];
}

export default function SeoHead({
  title,
  description,
  url,
  origin,
  type = 'website',
  siteName = SITE_NAME,
  locale = 'en',
  alternates = [],
  withImage = true,
  noindex = false,
  jsonLd = [],
}: Props) {
  const image = `${origin}${DEFAULT_SHARE_IMAGE.path}`;
  // eslint-disable-next-line sonarjs/null-dereference -- a prop string, never null
  const ogLocale = locale.replace('-', '_');
  return (
    <Head>
      <title key="title">{title}</title>
      <meta key="description" name="description" content={description} />
      <meta key="robots" name="robots" content={noindex ? 'noindex, follow' : 'index, follow'} />
      <link key="canonical" rel="canonical" href={url} />
      {alternates.map(alternate => (
        <link
          key={`alternate:${alternate.hreflang}`}
          rel="alternate"
          hrefLang={alternate.hreflang}
          href={alternate.href}
        />
      ))}
      <meta key="og:type" property="og:type" content={type} />
      <meta key="og:site_name" property="og:site_name" content={siteName} />
      <meta key="og:title" property="og:title" content={title} />
      <meta key="og:description" property="og:description" content={description} />
      <meta key="og:url" property="og:url" content={url} />
      <meta key="og:locale" property="og:locale" content={ogLocale} />
      {withImage ? <meta key="og:image" property="og:image" content={image} /> : null}
      {withImage ? (
        <meta key="og:image:width" property="og:image:width" content={String(DEFAULT_SHARE_IMAGE.width)} />
      ) : null}
      {withImage ? (
        <meta key="og:image:height" property="og:image:height" content={String(DEFAULT_SHARE_IMAGE.height)} />
      ) : null}
      {withImage ? <meta key="og:image:alt" property="og:image:alt" content={DEFAULT_SHARE_IMAGE.alt} /> : null}
      <meta key="twitter:card" name="twitter:card" content={withImage ? 'summary_large_image' : 'summary'} />
      <meta key="twitter:title" name="twitter:title" content={title} />
      <meta key="twitter:description" name="twitter:description" content={description} />
      {withImage ? <meta key="twitter:image" name="twitter:image" content={image} /> : null}
      {jsonLd.length === 0 ? null : (
        <script
          key="ld+json"
          type="application/ld+json"
          // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- JSON-LD built by us, `<` escaped
          dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
        />
      )}
    </Head>
  );
}
