// @mocco/backend — framework-agnostic backend. Next (frontend) only mounts it under app/api.
export * as db from './db/client';
export { authHandler, getSession, type Session, type AuthUser } from './auth';
export { trpcHandler } from './trpc/handler';
export type { AppRouter } from './trpc/router';
