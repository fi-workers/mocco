import { useState } from 'react';

import Button from '@/components/button';
import { Configure } from '@/lib/configure';
import { trpc } from '@/lib/trpc';

function throwClient(): never {
  throw new Error('Sentry client verification error');
}

// Verification-only page for confirming Sentry receives events from each surface:
// the client, a plain API route, and the tRPC error path. Gated client-side on
// Configure.DebugEnabled (NEXT_PUBLIC_DEBUG). Safe to remove once verified.
export default function SentryCheckPage() {
  const [note, setNote] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const callApiRoute = async () => {
    setNote('Calling /api/debug/sentry …');
    const res = await fetch('/api/debug/sentry');
    setNote(`API route responded ${res.status} (expected 500) — check Sentry.`);
  };

  const callTrpc = async () => {
    setNote('Calling tRPC debug.throwInternal …');
    try {
      await utils.debug.throwInternal.fetch();
    } catch (error) {
      setNote(`tRPC threw: "${(error as Error).message}" (masked) — check Sentry.`);
    }
  };

  if (!Configure.DebugEnabled) {
    return null;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 px-6 py-10">
      <h1 className="text-xl font-bold tracking-tight">Sentry check</h1>
      <p className="text-sm text-muted-foreground">
        DSN configured: <strong>{Configure.SentryDsn ? 'yes' : 'no'}</strong> · env {Configure.Environment}
      </p>
      <Button variant="neutral" onClick={throwClient} className="h-10 px-4 text-sm">
        Throw a client error
      </Button>
      <Button
        variant="secondary"
        onClick={async () => {
          await callApiRoute();
        }}
        className="h-10 px-4 text-sm">
        Trigger an API-route error
      </Button>
      <Button
        variant="secondary"
        onClick={async () => {
          await callTrpc();
        }}
        className="h-10 px-4 text-sm">
        Trigger a tRPC error
      </Button>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
    </main>
  );
}
