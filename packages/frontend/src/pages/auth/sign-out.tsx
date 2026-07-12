import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { signOut } from '../../lib/auth-client';
import { Routes } from '../../lib/routes';

// Signs the user out on load, then returns them to the public landing page.
export default function SignOutPage() {
  const router = useRouter();

  useEffect(() => {
    const signOutAndRedirect = async () => {
      await signOut();
      await router.replace(Routes.home);
    };
    signOutAndRedirect();
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-neutral-500">Signing out…</p>
    </main>
  );
}
