import Image from 'next/image';
import Link from 'next/link';

import { Routes } from '@frontend/lib/routes';

// Public landing page. Auth lives at /auth/* (reached from the nav or the CTA).
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col">
      <nav className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <Image src="/favicon/favicon.svg" alt="Mocco" width={32} height={32} className="rounded-lg" />
          <span className="font-semibold tracking-tight">Mocco</span>
        </div>
        <Link
          href={Routes.signIn}
          className="text-sm font-medium text-muted-foreground transition hover:text-foreground">
          Log in
        </Link>
      </nav>

      <section className="flex flex-1 flex-col items-center justify-center gap-8 px-6 text-center">
        <div className="max-w-xl">
          <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">Write ≠ deploy.</h1>
          <p className="mx-auto mt-5 max-w-lg text-pretty leading-relaxed text-muted-foreground">
            Mocco is a deploy governance control plane on top of GitHub Actions. Pipelines pause at gates, and only an
            authorized role can resume them — production can&apos;t ship without a verified, approved run.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href={Routes.signUp}
            className="inline-flex h-11 items-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90">
            Get started
          </Link>
          <a
            href="https://github.com/fi-workers/mocco"
            className="inline-flex h-11 items-center rounded-lg border border-border px-5 text-sm font-medium text-foreground transition hover:bg-muted">
            GitHub
          </a>
        </div>
      </section>
    </main>
  );
}
