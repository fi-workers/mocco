'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { signIn, signUp, useSession } from '../lib/auth-client';

type Mode = 'sign-in' | 'sign-up';

export default function Home() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submitLabel = mode === 'sign-up' ? 'Create account' : 'Sign in';

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const result = mode === 'sign-up' ? await signUp({ email, password, name }) : await signIn({ email, password });
    if (result.error) {
      setError(result.error.message ?? 'Something went wrong');
      setLoading(false);
      return;
    }
    router.push('/account');
  };

  let card;
  if (isPending) {
    card = <div className="h-11 animate-pulse rounded-lg bg-neutral-100" />;
  } else if (session) {
    card = (
      <Link
        href="/account"
        className="flex h-11 w-full items-center justify-center rounded-lg bg-violet-600 text-sm font-medium text-white transition hover:bg-violet-700">
        Continue as {session.user.name ?? session.user.email} →
      </Link>
    );
  } else {
    card = (
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {mode === 'sign-up' && (
          <input
            type="text"
            required
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Name"
            className="h-11 rounded-lg border border-neutral-200 px-3 text-sm outline-none focus:border-violet-500"
          />
        )}
        <input
          type="email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="Email"
          className="h-11 rounded-lg border border-neutral-200 px-3 text-sm outline-none focus:border-violet-500"
        />
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password (8+ characters)"
          className="h-11 rounded-lg border border-neutral-200 px-3 text-sm outline-none focus:border-violet-500"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="flex h-11 w-full items-center justify-center rounded-lg bg-neutral-900 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50">
          {loading ? 'Working…' : submitLabel}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
            setError(null);
          }}
          className="text-sm text-neutral-500 hover:text-neutral-800">
          {mode === 'sign-in' ? 'No account? Create one' : 'Have an account? Sign in'}
        </button>
      </form>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <div className="max-w-md text-center">
        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-violet-600 text-lg font-bold text-white">
          M
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Mocco</h1>
        <p className="mt-3 text-sm leading-relaxed text-neutral-500">
          Deploy governance control plane on top of GitHub Actions.
          <br />
          write ≠ deploy — gates pause pipelines until the right role resumes them.
        </p>
      </div>

      <div className="w-full max-w-xs">{card}</div>
    </main>
  );
}
