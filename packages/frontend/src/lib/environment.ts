// The app's three environments, modeled on the checkable app's Environment enum.
// Keys and values match exactly (no external contract forces a casing). Resolved
// from Vercel's VERCEL_ENV (bridged to the client as NEXT_PUBLIC_VERCEL_ENV in
// next.config):
//   Local — off Vercel (localhost)   · Dev — Vercel preview   · Prod — Vercel production
export enum Environment {
  Local = 'Local',
  Dev = 'Dev',
  Prod = 'Prod',
}

function resolve(vercelEnv: string | undefined): Environment {
  switch (vercelEnv) {
    case 'production':
      return Environment.Prod;
    case 'preview':
      return Environment.Dev;
    default:
      return Environment.Local;
  }
}

export const ENVIRONMENT = resolve(process.env.NEXT_PUBLIC_VERCEL_ENV);
