// The answer of the console's end-user token route (Mocco on Mocco, docs/reference/mocco-on-mocco.md).
// Kept apart from ./mocco-self so the console's first load doesn't pull in zod; the widgets load it
// with their own code.
import { z } from 'zod';

/** What `GET /api/self/end-user-token` answers a signed-in console user. */
export const selfEndUserTokenSchema = z.object({ token: z.string().min(1), expiresAt: z.iso.datetime() });

export type SelfEndUserToken = z.infer<typeof selfEndUserTokenSchema>;
