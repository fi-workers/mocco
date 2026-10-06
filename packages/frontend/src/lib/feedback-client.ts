// The browser side of the public feedback board pages (#175): the signed-in end user's token and
// the calls to /api/ext/sites/<site>/feedback, the /v1 feedback routes behind the site instead
// of a key. Answers are parsed through the same @mocco/common/feedback-v1 schemas.
/* eslint-disable unicorn/no-unnecessary-global-this -- the bare `location`, `history` and event
   functions are restricted globals (no-restricted-globals), as in connect-github-button.tsx */
import { FeedbackPostStatuses } from '@mocco/common/feedback';
import { useRouter } from 'next/router';
import { useEffect, useSyncExternalStore } from 'react';
import { z } from 'zod';

import type { FeedbackPostStatus } from '@mocco/common/feedback';

export const feedbackStatusLabels: Record<FeedbackPostStatus, string> = {
  [FeedbackPostStatuses.underReview]: 'Under review',
  [FeedbackPostStatuses.planned]: 'Planned',
  [FeedbackPostStatuses.inProgress]: 'In progress',
  [FeedbackPostStatuses.shipped]: 'Shipped',
  [FeedbackPostStatuses.closed]: 'Closed',
};

/** The query parameter an app hands its signed-in user's token over in. */
export const TOKEN_PARAM = 'token';
const TOKEN_EVENT = 'mocco-feedback-token';
const storageKey = (site: string) => `mocco-feedback-token:${site}`;

function readToken(site: string): string | undefined {
  try {
    return sessionStorage.getItem(storageKey(site)) ?? undefined;
  } catch {
    // Storage off: the visitor reads and votes by email.
    return undefined;
  }
}

/** Forget the token (the server refused it): the page falls back to voting by email. */
export function forgetToken(site: string): void {
  try {
    sessionStorage.removeItem(storageKey(site));
  } catch {
    // Storage off: nothing was kept.
  }
  globalThis.dispatchEvent(new Event(TOKEN_EVENT));
}

const subscribe = (onChange: () => void) => {
  globalThis.addEventListener(TOKEN_EVENT, onChange);
  globalThis.addEventListener('storage', onChange);
  return () => {
    globalThis.removeEventListener(TOKEN_EVENT, onChange);
    globalThis.removeEventListener('storage', onChange);
  };
};

/**
 * The signed-in end user's token on this site, or undefined. An app links its signed-in user to the
 * board with `?token=<a JWT its server signed>`: the page keeps it for this tab and takes it out
 * of the address, so it isn't bookmarked, shared or sent on as a referrer. An expired or refused
 * token is forgotten when the routes refuse it.
 */
export function useEndUserToken(site: string): string | undefined {
  // Through the router, once it is ready: on a page opened with a query, Next puts the address
  // back itself on hydration, which would undo a plain history.replaceState.
  const router = useRouter();
  const { isReady } = router;
  useEffect(() => {
    if (!isReady) {
      return;
    }
    const url = new URL(globalThis.location.href);
    const handed = url.searchParams.get(TOKEN_PARAM);
    if (handed === null) {
      return;
    }
    try {
      sessionStorage.setItem(storageKey(site), handed);
    } catch {
      // Storage off: the token can't be kept past this page.
    }
    url.searchParams.delete(TOKEN_PARAM);
    globalThis.dispatchEvent(new Event(TOKEN_EVENT));
    // eslint-disable-next-line no-void -- an effect can't await a shallow route change
    void router.replace(`${url.pathname}${url.search}${url.hash}`, undefined, { shallow: true, scroll: false });
    // Re-runs on each route change too, harmlessly: without the parameter there is nothing to do.
  }, [site, isReady, router]);
  return useSyncExternalStore(
    subscribe,
    () => readToken(site),
    () => undefined,
  );
}

/** The problem type the routes answer a refused end-user token with. */
const INVALID_TOKEN_PROBLEM = 'https://mocco.dev/problems/invalid_end_user_token';

const problemSchema = z.object({ type: z.string().optional(), title: z.string().optional() });

export type FeedbackCallResult<T> =
  { ok: true; data: T } | { ok: false; status: number; title: string; isTokenRefused: boolean };

/** One call to the site's feedback routes, its answer parsed by `schema`. */
export async function feedbackCall<S extends z.ZodType>(
  site: string,
  path: string,
  schema: S,
  init: { method?: string; token?: string; body?: object } = {},
): Promise<FeedbackCallResult<z.infer<S>>> {
  try {
    const response = await fetch(`/api/ext/sites/${encodeURIComponent(site)}/feedback${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.token !== undefined && { authorization: `Bearer ${init.token}` }),
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
    const json: unknown = await response.json();
    if (response.ok) {
      const parsed = schema.safeParse(json);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : { ok: false, status: 502, title: 'Unexpected answer', isTokenRefused: false };
    }
    const problem = problemSchema.safeParse(json);
    const { type, title } = problem.success ? problem.data : {};
    return {
      ok: false,
      status: response.status,
      title: title ?? 'Something went wrong',
      isTokenRefused: type === INVALID_TOKEN_PROBLEM,
    };
  } catch {
    return { ok: false, status: 0, title: "Couldn't reach the board. Try again.", isTokenRefused: false };
  }
}
