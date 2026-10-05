import { Html, Head, Main, NextScript } from 'next/document';
import { z } from 'zod';

import type { DocumentProps } from 'next/document';

// A help center page is in its reader's language; everything else Mocco serves is English.
const helpPageProps = z.object({ nav: z.object({ locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u) }) });

export default function Document(props: DocumentProps) {
  const parsed = helpPageProps.safeParse(props.__NEXT_DATA__.props?.pageProps);
  return (
    <Html lang={parsed.success ? parsed.data.nav.locale : 'en'}>
      <Head>
        {/* Favicons — modern minimal set (favicon.ico for legacy tools, SVG for
            crisp/theme-aware, apple-touch for iOS, manifest for PWA/maskable). */}
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" href="/favicon/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon/favicon-96x96.png" type="image/png" sizes="96x96" />
        <link rel="apple-touch-icon" href="/favicon/apple-touch-icon.png" />
        <link rel="manifest" href="/favicon/site.webmanifest" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
