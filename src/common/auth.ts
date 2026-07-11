import { z } from 'zod';

/**
 * Neutral session/user shapes — OUR contract, defined as zod schemas instead of
 * vendor type inference. The backend annotates its returns with these; vendor
 * rows are structurally-compatible supersets, so nothing is converted.
 */
export const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const sessionSchema = z.object({
  session: z.object({
    id: z.string(),
    userId: z.string(),
    expiresAt: z.date(),
  }),
  user: authUserSchema,
});
export type Session = z.infer<typeof sessionSchema>;
