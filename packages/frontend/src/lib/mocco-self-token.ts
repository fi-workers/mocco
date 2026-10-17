import { SELF_END_USER_TOKEN_PATH } from '@mocco/common/mocco-self';
import { selfEndUserTokenSchema } from '@mocco/common/mocco-self-token';

// Mocco on Mocco: the signed-in console user's end-user token for Mocco's own project, for the
// console's @mocco/js widgets. Loaded with them (a dynamic import), so its zod stays out of the
// console's first load.

/** The token, or null (signed out, not configured, or an unexpected answer): the widgets are then read-only. */
export async function selfEndUserToken(): Promise<string | null> {
  const response = await fetch(SELF_END_USER_TOKEN_PATH, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    return null;
  }
  const parsed = selfEndUserTokenSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.token : null;
}
