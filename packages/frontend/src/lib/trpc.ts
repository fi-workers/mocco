// Typed tRPC React Query hooks — the client-side data layer. The client itself
// (same-origin /api/trpc, superjson to match the server) is created in _app and
// handed to `trpc.Provider`.
import { createTRPCReact } from '@trpc/react-query';

import type { AppRouter } from '@mocco/backend/trpc/root';

export const trpc = createTRPCReact<AppRouter>();
