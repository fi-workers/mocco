import { zodResolver } from '@hookform/resolvers/zod';
import Image from 'next/image';
import Link from 'next/link';
import { useForm } from 'react-hook-form';

import { Button } from '@frontend/components/ui/button';
import { signIn, signUp } from '@frontend/lib/auth-client';
import { signInSchema, signUpSchema } from '@frontend/lib/auth-schema';
import { Routes } from '@frontend/lib/routes';

import type { SignUpValues } from '@frontend/lib/auth-schema';
import type { Resolver } from 'react-hook-form';

const INPUT = 'h-11 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring';

// Shared by /auth/sign-in and /auth/sign-up — one form, two modes. react-hook-form
// + the mode's zod schema (sign-up also requires a name).
export default function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
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
    // Full navigation (not client push) so the destination reads the freshly-set
    // session cookie — better-auth's useSession doesn't refetch after an in-page
    // sign-in, which would leave the auth guard seeing no session.
    // eslint-disable-next-line unicorn/no-unnecessary-global-this -- bare `location` trips no-restricted-globals and `window` trips prefer-global-this; globalThis is the one form that satisfies both
    globalThis.location.assign(Routes.workspaces);
  });

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <Link href={Routes.home} className="flex flex-col items-center gap-3 text-center">
        <Image src="/favicon/favicon.svg" alt="Mocco" width={44} height={44} className="rounded-xl" />
        <h1 className="text-2xl font-bold tracking-tight">Mocco</h1>
      </Link>

      <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-3">
        {isSignUp && (
          <div>
            <input {...register('name')} placeholder="Name" aria-label="Name" className={`w-full ${INPUT}`} />
            {errors.name && <p className="mt-1 text-sm text-destructive">{errors.name.message}</p>}
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
          {errors.email && <p className="mt-1 text-sm text-destructive">{errors.email.message}</p>}
        </div>
        <div>
          <input
            {...register('password')}
            type="password"
            placeholder="Password (8+ characters)"
            aria-label="Password"
            className={`w-full ${INPUT}`}
          />
          {errors.password && <p className="mt-1 text-sm text-destructive">{errors.password.message}</p>}
        </div>
        {errors.root && <p className="text-sm text-destructive">{errors.root.message}</p>}
        <Button type="submit" pending={isSubmitting} className="h-11 w-full text-sm">
          {submitLabel}
        </Button>
        <Link
          href={isSignUp ? Routes.signIn : Routes.signUp}
          className="text-center text-sm text-muted-foreground transition hover:text-foreground">
          {isSignUp ? 'Have an account? Sign in' : 'No account? Create one'}
        </Link>
      </form>
    </main>
  );
}
