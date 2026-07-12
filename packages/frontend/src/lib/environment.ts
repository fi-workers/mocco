// The app's three environments, modeled on the checkable app's Environment
// constant. Resolved from Vercel's VERCEL_ENV (bridged to the client as
// NEXT_PUBLIC_VERCEL_ENV in next.config):
//   local — off Vercel (localhost)   · dev — Vercel preview   · prod — Vercel production
export const Environment = {
  Local: 'local',
  Dev: 'dev',
  Prod: 'prod',
} as const;

export type Environment = (typeof Environment)[keyof typeof Environment];

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

export const ENVIRONMENT: Environment = resolve(process.env.NEXT_PUBLIC_VERCEL_ENV);
