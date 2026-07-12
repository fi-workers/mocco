import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useForm } from 'react-hook-form';

import { signIn, signUp } from '@/lib/auth-client';
import { signInSchema, signUpSchema } from '@/lib/auth-schema';
import { Routes } from '@/lib/routes';

import Button from './button';

import type { SignUpValues } from '@/lib/auth-schema';
import type { Resolver } from 'react-hook-form';

const INPUT = 'h-11 rounded-lg border border-neutral-200 px-3 text-sm outline-none focus:border-violet-500';

// Shared by /auth/sign-in and /auth/sign-up — one form, two modes. react-hook-form
// + the mode's zod schema (sign-up also requires a name).
export default function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const router = useRouter();
  const isSignUp = mode === 'sign-up';
  const submitLabel = isSignUp ? 'Create account' : 'Sign in';

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignUpValues>({
    // sign-in validates only email+password (its `name` field isn't rendered), so
    // its resolver shape is narrower than the form's — reconcile via unknown.
    resolver: zodResolver(isSignUp ? signUpSchema : signInSchema) as unknown as Resolver<SignUpValues>,
    defaultValues: { name: '', email: '', password: '' },
  });

  const submit = handleSubmit(async ({ email, password, name }) => {
    const result = isSignUp ? await signUp({ email, password, name }) : await signIn({ email, password });
    if (result.error) {
      setError('root', { message: result.error.message ?? 'Something went wrong' });
      return;
    }
    await router.push(Routes.workspaces);
  });

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <Link href={Routes.home} className="text-center">
        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-violet-600 text-lg font-bold text-white">
          M
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Mocco</h1>
      </Link>

      <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-3">
        {isSignUp && (
          <div>
            <input {...register('name')} placeholder="Name" aria-label="Name" className={`w-full ${INPUT}`} />
            {errors.name && <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>}
          </div>
        )}
        <div>
          <input
            {...register('email')}
            type="email"
            placeholder="Email"
            aria-label="Email"
            className={`w-full ${INPUT}`}
          />
          {errors.email && <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>}
        </div>
        <div>
          <input
            {...register('password')}
            type="password"
            placeholder="Password (8+ characters)"
            aria-label="Password"
            className={`w-full ${INPUT}`}
          />
          {errors.password && <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>}
        </div>
        {errors.root && <p className="text-sm text-red-600">{errors.root.message}</p>}
        <Button type="submit" variant="neutral" pending={isSubmitting} className="h-11 w-full text-sm">
          {isSubmitting ? 'Working…' : submitLabel}
        </Button>
        <Link
          href={isSignUp ? Routes.signIn : Routes.signUp}
          className="text-center text-sm text-neutral-500 transition hover:text-neutral-800">
          {isSignUp ? 'Have an account? Sign in' : 'No account? Create one'}
        </Link>
      </form>
    </main>
  );
}
