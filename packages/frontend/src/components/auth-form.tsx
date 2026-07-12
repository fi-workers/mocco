import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { signIn, signUp } from '../lib/auth-client';

import Button from './button';

// Shared by /auth/sign-in and /auth/sign-up — one form, two modes.
export default function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignUp = mode === 'sign-up';
  const submitLabel = isSignUp ? 'Create account' : 'Sign in';

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const result = isSignUp ? await signUp({ email, password, name }) : await signIn({ email, password });
    if (result.error) {
      setError(result.error.message ?? 'Something went wrong');
      setLoading(false);
      return;
    }
    await router.push('/account');
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <Link href="/" className="text-center">
        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-violet-600 text-lg font-bold text-white">
          M
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Mocco</h1>
      </Link>

      <form onSubmit={handleSubmit} className="flex w-full max-w-xs flex-col gap-3">
        {isSignUp && (
          <input
            type="text"
            required
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Name"
            aria-label="Name"
            className="h-11 rounded-lg border border-neutral-200 px-3 text-sm outline-none focus:border-violet-500"
          />
        )}
        <input
          type="email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="Email"
          aria-label="Email"
          className="h-11 rounded-lg border border-neutral-200 px-3 text-sm outline-none focus:border-violet-500"
        />
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password (8+ characters)"
          aria-label="Password"
          className="h-11 rounded-lg border border-neutral-200 px-3 text-sm outline-none focus:border-violet-500"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" variant="neutral" pending={loading} className="h-11 w-full text-sm">
          {loading ? 'Working…' : submitLabel}
        </Button>
        <Link
          href={isSignUp ? '/auth/sign-in' : '/auth/sign-up'}
          className="text-center text-sm text-neutral-500 transition hover:text-neutral-800">
          {isSignUp ? 'Have an account? Sign in' : 'No account? Create one'}
        </Link>
      </form>
    </main>
  );
}
