import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import Head from 'next/head';
import { useState } from 'react';
import superjson from 'superjson';

import EnvironmentRibbon from '@/components/environment-ribbon';
import { trpc } from '@/lib/trpc';

import '@/styles/globals.css';

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
          <title>Mocco</title>
          <meta name="description" content="Pipeline governance control plane" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </Head>
        <EnvironmentRibbon />
        <Component {...pageProps} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}
