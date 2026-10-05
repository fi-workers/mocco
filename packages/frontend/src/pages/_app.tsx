import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import Head from 'next/head';
import { useState } from 'react';
import superjson from 'superjson';

import EnvironmentRibbon from '@frontend/components/environment-ribbon';
import { trpc } from '@frontend/lib/trpc';

import '@frontend/styles/globals.css';

import type { AppProps } from 'next/app';

export default function App({ Component, pageProps }: AppProps) {
  // One client per browser session (kept in state so a re-render doesn't rebuild it).
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({ links: [httpBatchLink({ url: '/api/trpc', transformer: superjson })] }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Head>
          <title key="title">Mocco</title>
          {/* The console and auth screens stay out of search; public pages override this (SeoHead). */}
          <meta key="robots" name="robots" content="noindex" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </Head>
        <EnvironmentRibbon />
        <Component {...pageProps} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}
