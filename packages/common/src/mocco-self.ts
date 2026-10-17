// Mocco on Mocco: the console shows Mocco's own "What's new" badge and feedback sheet, powered by
// a Mocco project (docs/reference/mocco-on-mocco.md). The console reads its public settings from
// NEXT_PUBLIC_MOCCO_SELF_* and its signed-in user's end-user token from /api/self/end-user-token
// (its answer's schema is in ./mocco-self-token, so this module stays free of zod: the console's
// first load imports it).
/** The console's same-origin route that signs the signed-in user's end-user token. */
export const SELF_END_USER_TOKEN_PATH = '/api/self/end-user-token';

/** The /v1 path on Mocco's own origin, the widgets' API when no URL is set. */
export const SELF_DEFAULT_API_PATH = '/api/ext/v1';

/** How long a console user's end-user token is valid for (Mocco takes at most an hour). */
export const SELF_END_USER_TOKEN_TTL_SECONDS = 10 * 60;

/** A build env value: unset and blank are the same. */
const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
};

export interface SelfWidgetsConfig {
  publishableKey: string;
  board: string;
  /** The /v1 base the SDK calls; undefined means the page's own origin. */
  apiUrl: string | undefined;
}

/**
 * The widgets' settings, or null when the console shouldn't show them: the key or the board is
 * missing, or the API URL isn't a URL. Values come from the build's env, so an empty string is
 * the same as unset.
 */
export function selfWidgetsConfigOf(raw: {
  publishableKey?: string;
  board?: string;
  apiUrl?: string;
}): SelfWidgetsConfig | null {
  const publishableKey = present(raw.publishableKey);
  const board = present(raw.board);
  const apiUrl = present(raw.apiUrl);
  const isUsable =
    publishableKey !== undefined && board !== undefined && (apiUrl === undefined || URL.canParse(apiUrl));
  return isUsable ? { publishableKey, board, apiUrl } : null;
}

/** The /v1 base for `config` on a page served from `origin`. */
export const selfApiUrlOf = (config: SelfWidgetsConfig, origin: string): string =>
  config.apiUrl ?? `${origin}${SELF_DEFAULT_API_PATH}`;
