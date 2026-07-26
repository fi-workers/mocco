// The production HttpPost binding — the single outbound-HTTP leaf of the execution
// loop (the generic executor's trigger and its callbacks). Kept off the services
// so they stay transport-free; the composition root injects it.
import type { HttpPost } from '@backend/domain/execution/ports';

/** Fire a JSON POST, throwing on a non-2xx so the caller (wrapped in `waitUntil`)
 * can log-and-park a failed dispatch rather than silently drop it. */
export const postJson: HttpPost = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed with status ${response.status}`);
  }
};
