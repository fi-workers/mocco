import Head from 'next/head';
import Image from 'next/image';
import Link from 'next/link';

import { productCatalog, sectionGroupLabels, SectionGroups } from '@frontend/lib/products';
import { Routes } from '@frontend/lib/routes';

import type { SectionGroup } from '@frontend/lib/products';

const GITHUB_URL = 'https://github.com/fi-workers/mocco';

interface Pillar {
  group: SectionGroup;
  summary: string;
  products: { name: string; description: string; href: string }[];
}

// The products that have screens today, grouped by the job they do. The roadmap row
// below is read from the product registry, so it never lists a product that shipped.
const pillarsByJob: Pillar[] = [
  {
    group: SectionGroups.release,
    summary: 'Write ≠ ship: every production change waits for the right people.',
    products: [
      {
        name: 'Deploy governance',
        description: 'Pipelines pause at gates on GitHub Actions. Production credentials exist only after approval.',
        href: Routes.guide('governance', 'overview'),
      },
      {
        name: 'OTA updates',
        description: 'Host React Native updates with rollouts and instant rollback, or gate the tool you use today.',
        href: Routes.guide('ota', 'overview'),
      },
      {
        name: 'Force update',
        description: 'Minimum and recommended versions per store app, raised only with approval.',
        href: Routes.guide('ota', 'force-update'),
      },
      {
        name: 'Feature flags',
        description: 'Targeting, segments and rollouts over OpenFeature, with approvals and a kill switch.',
        href: Routes.guide('flags', 'quickstart'),
      },
    ],
  },
  {
    group: SectionGroups.support,
    summary: 'Hear from the people who use what you built.',
    products: [
      {
        name: 'Messenger',
        description: 'Users write to you from inside your app; your team answers from one inbox.',
        href: Routes.guide('messenger', 'contact-us'),
      },
      {
        name: 'Help center',
        description: 'A public help site in Markdown, on your own domain, translated and searchable from your app.',
        href: Routes.guide('help', 'help-center'),
      },
    ],
  },
  {
    group: SectionGroups.operate,
    summary: 'Know what happened, and who did it.',
    products: [
      {
        name: 'Notifications',
        description: 'Mocco, Sentry, Vercel and GitHub events routed to the Discord channels that need them.',
        href: Routes.guide('notifications', 'overview'),
      },
      {
        name: 'Audit log',
        description: 'Every approval, credential release and production change, in one record.',
        href: Routes.guide('start', 'audit-log'),
      },
    ],
  },
];

// Shown in the registry's group order, the order every list in Mocco follows.
const groupOrder: readonly SectionGroup[] = Object.values(SectionGroups);
const pillars = pillarsByJob.toSorted((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));

// An illustration of one morning in a workspace: every product in one feed.
const feed = [
  { time: '09:12', area: 'Release', text: 'api deployed to production', detail: 'gate approved by Minji' },
  { time: '09:40', area: 'Operate', text: 'Sentry: CheckoutError is spiking', detail: 'posted to #oncall on Discord' },
  { time: '09:41', area: 'Release', text: 'Kill switch: new-checkout off', detail: 'applied at once · by Ben' },
  { time: '09:55', area: 'Support', text: '“I can’t pay with my card”', detail: 'new conversation in the inbox' },
  {
    time: '10:20',
    area: 'Support',
    text: 'Help article “Payment methods” published',
    detail: 'in English, Korean and Japanese',
  },
];

const reasons = [
  {
    title: 'One team, one set of roles',
    text: 'Invite people once. The role that approves a deploy also approves a flag change, an OTA release or a raised minimum version.',
  },
  {
    title: 'One record',
    text: 'Every approval, production change and credential release, from every product, lands in the same tamper-evident audit log.',
  },
  {
    title: 'One place to look',
    text: 'Home shows the approvals waiting across products; alerts from Sentry, Vercel and GitHub and your users’ messages arrive in the same workspace.',
  },
];

const developerSurfaces = [
  {
    name: 'SDKs',
    text: 'OpenFeature providers for Node, web and React Native, and a React Native SDK for OTA, messenger and help.',
    code: 'npm install @mocco/openfeature-server',
  },
  {
    name: 'CLI',
    text: 'Publish OTA updates from CI. Your signing key never leaves CI, and Mocco serves exactly the bytes it signed.',
    code: 'npx mocco ota publish --channel staging',
  },
  {
    name: 'MCP',
    text: 'Agents read what Mocco knows. Anything that approves or ships still needs a person.',
    code: 'claude mcp add --transport http mocco https://www.mocco.club/api/mcp',
  },
];

const comingNext = Object.values(productCatalog)
  .filter(entry => !entry.available)
  .map(entry => entry.label);

const primaryButton =
  'inline-flex h-11 items-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90';
const secondaryButton =
  'inline-flex h-11 items-center rounded-lg border border-border px-5 text-sm font-medium text-foreground transition hover:bg-muted';

// Public landing page (static). Auth lives at /auth/* (reached from the nav or the CTAs).
export default function Home() {
  return (
    <>
      <Head>
        <title>Mocco — everything your product needs, except the code</title>
        <meta
          name="description"
          content="Ship it, run it and hear from the people who use it, in one workspace: deploy approvals, OTA updates, feature flags, alerts, in-app messaging and a help center that share one team, one set of roles and one history."
        />
      </Head>
      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
          <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
            <Link href={Routes.home} className="flex items-center gap-2">
              <Image src="/favicon/favicon.svg" alt="" width={28} height={28} className="rounded-lg" />
              <span className="font-semibold tracking-tight">Mocco</span>
            </Link>
            <div className="flex items-center gap-1 text-sm font-medium sm:gap-4">
              <a
                href="#products"
                className="hidden px-2 text-muted-foreground transition hover:text-foreground sm:inline">
                Products
              </a>
              <Link
                href={Routes.guide('start', 'overview')}
                className="hidden px-2 text-muted-foreground transition hover:text-foreground sm:inline">
                Docs
              </Link>
              <a
                href={GITHUB_URL}
                className="hidden px-2 text-muted-foreground transition hover:text-foreground sm:inline">
                GitHub
              </a>
              <Link href={Routes.signIn} className="px-2 text-muted-foreground transition hover:text-foreground">
                Log in
              </Link>
              <Link
                href={Routes.signUp}
                className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-primary-foreground transition hover:bg-primary/90">
                Get started
              </Link>
            </div>
          </nav>
        </header>

        <main className="flex flex-col">
          <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1.1fr_1fr]">
            <div className="flex flex-col gap-6">
              <p className="text-sm font-medium text-muted-foreground">For teams that build and run a service</p>
              <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
                Everything your product needs,
                <br />
                except the code.
              </h1>
              <p className="max-w-xl leading-relaxed text-pretty text-muted-foreground">
                Ship it, run it and hear from the people who use it — in one workspace. Deploys, OTA updates, feature
                flags, alerts, in-app messaging and your help center share the same team, the same roles and the same
                history, instead of ten tools that don’t know about each other.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link href={Routes.signUp} className={primaryButton}>
                  Get started
                </Link>
                <Link href={Routes.guide('start', 'overview')} className={secondaryButton}>
                  Read the docs
                </Link>
              </div>
            </div>

            <figure className="flex flex-col gap-3">
              <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
                <p className="px-1 pb-3 text-xs font-medium text-muted-foreground">
                  Example · one morning in a workspace
                </p>
                <ol className="flex flex-col">
                  {feed.map(entry => (
                    <li
                      key={`${entry.time}-${entry.text}`}
                      className="flex gap-3 border-t border-border px-1 py-2.5 first:border-t-0">
                      <span className="w-11 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                        {entry.time}
                      </span>
                      <span className="w-16 shrink-0">
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium">{entry.area}</span>
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm">{entry.text}</span>
                        <span className="text-xs text-muted-foreground">{entry.detail}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
              <figcaption className="text-xs text-muted-foreground">
                Release, operations and support in one feed, for one team.
              </figcaption>
            </figure>
          </section>

          <section
            id="products"
            className="mx-auto flex w-full max-w-6xl scroll-mt-16 flex-col gap-10 px-4 py-16 sm:px-6">
            <div className="flex max-w-2xl flex-col gap-3">
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Use one product, or all of them.</h2>
              <p className="leading-relaxed text-muted-foreground">
                Start with the one you need today and turn on the rest when you need them, per workspace.
              </p>
            </div>
            <div className="grid gap-8 lg:grid-cols-3">
              {pillars.map(pillar => (
                <div key={pillar.group} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                      {sectionGroupLabels[pillar.group]}
                    </h3>
                    <p className="text-sm">{pillar.summary}</p>
                  </div>
                  <ul className="flex flex-col gap-3">
                    {pillar.products.map(product => (
                      <li key={product.name}>
                        <Link
                          href={product.href}
                          className="group flex flex-col gap-1 rounded-xl border border-border p-4 transition hover:bg-muted">
                          <span className="text-sm font-medium">
                            {product.name}{' '}
                            <span
                              aria-hidden="true"
                              className="text-muted-foreground transition group-hover:text-foreground">
                              →
                            </span>
                          </span>
                          <span className="text-sm leading-relaxed text-muted-foreground">{product.description}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Coming next:</span> {comingNext.join(' · ')}
            </p>
          </section>

          <section className="border-y border-border bg-muted/40">
            <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-16 sm:px-6">
              <div className="flex max-w-2xl flex-col gap-3">
                <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">One workspace, not ten tools.</h2>
                <p className="leading-relaxed text-muted-foreground">
                  Separate tools each keep their own users, permissions and logs. In Mocco every product starts from the
                  same ones.
                </p>
              </div>
              <ul className="grid gap-4 sm:grid-cols-3">
                {reasons.map(reason => (
                  <li
                    key={reason.title}
                    className="flex flex-col gap-2 rounded-xl border border-border bg-background p-5">
                    <h3 className="text-sm font-semibold">{reason.title}</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">{reason.text}</p>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="border-t border-border">
            <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-16 sm:px-6">
              <div className="flex max-w-2xl flex-col gap-3">
                <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">For your team and your agents.</h2>
                <p className="leading-relaxed text-muted-foreground">
                  The console, the public API, the SDKs, the CLI and the MCP server sit on the same services and check
                  the same roles.
                </p>
              </div>
              <ul className="grid gap-4 lg:grid-cols-3">
                {developerSurfaces.map(surface => (
                  <li key={surface.name} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-5">
                    <h3 className="text-sm font-semibold">{surface.name}</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">{surface.text}</p>
                    <pre className="mt-auto overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs">
                      <code>{surface.code}</code>
                    </pre>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="border-t border-border bg-muted/40">
            <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-16 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex max-w-xl flex-col gap-2">
                <h2 className="text-2xl font-semibold tracking-tight">Open source. Self-hostable.</h2>
                <p className="leading-relaxed text-muted-foreground">
                  Mocco is AGPL-3.0 and runs on Node and Postgres, on Vercel or your own servers. The SDKs are MIT.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link href={Routes.signUp} className={primaryButton}>
                  Get started
                </Link>
                <a href={GITHUB_URL} className={secondaryButton}>
                  View on GitHub
                </a>
              </div>
            </div>
          </section>
        </main>

        <footer className="border-t border-border">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-sm text-muted-foreground sm:px-6">
            <span>Mocco</span>
            <div className="flex gap-4">
              <Link href={Routes.guide('start', 'overview')} className="transition hover:text-foreground">
                Docs
              </Link>
              <a href={GITHUB_URL} className="transition hover:text-foreground">
                GitHub
              </a>
              <a href={`${GITHUB_URL}/blob/main/LICENSE`} className="transition hover:text-foreground">
                License
              </a>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
