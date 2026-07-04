'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { signOut, useSession } from '../../lib/auth-client';

export default function AccountPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!isPending && !session) router.replace('/');
  }, [isPending, session, router]);

  if (isPending || !session) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-violet-600" />
      </main>
    );
  }

  const { user } = session;

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
      router.replace('/');
    } catch {
      setSigningOut(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 px-6">
      <h1 className="text-xl font-bold tracking-tight">Account</h1>

      <div className="flex items-center gap-4 rounded-xl border border-neutral-200 p-5">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-600 font-semibold text-white">
          {(user.name ?? user.email).charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="truncate font-medium">{user.name ?? '(no name)'}</div>
          <div className="truncate text-sm text-neutral-500">{user.email}</div>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSignOut}
        disabled={signingOut}
        className="h-11 rounded-lg border border-neutral-200 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50">
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </main>
  );
}
