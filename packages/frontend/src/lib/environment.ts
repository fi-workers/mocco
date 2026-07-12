// The app's three environments as an `as const` object (no TS enum) with a derived
// union type — plural const name, singular type name. Keys match their values
// (no external contract forces a casing). Resolved from Vercel's VERCEL_ENV
// (bridged to the client as NEXT_PUBLIC_VERCEL_ENV in next.config):
//   Local — off Vercel (localhost)   · Dev — Vercel preview   · Prod — Vercel production
export const Environments = {
  Local: 'Local',
  Dev: 'Dev',
  Prod: 'Prod',
} as const;

export type Environment = (typeof Environments)[keyof typeof Environments];

// 'production' / 'preview' are Vercel's raw external values — parsed here at the
// boundary; everything downstream uses the Environments constant, never a literal.
function resolve(vercelEnv: string | undefined): Environment {
  switch (vercelEnv) {
    case 'production':
      return Environments.Prod;
    case 'preview':
      return Environments.Dev;
    default:
      return Environments.Local;
  }
}

export const ENVIRONMENT: Environment = resolve(process.env.NEXT_PUBLIC_VERCEL_ENV);
