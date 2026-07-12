/**
 * Run a promise for its side effect, ignoring the outcome — for intentional
 * fire-and-forget work like client-side redirects inside effects and mutation
 * callbacks, where there is nowhere to await.
 */
export function fireAndForget(promise: Promise<unknown>): void {
  // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget by design; there is no caller to await
  promise.catch(() => undefined);
}
