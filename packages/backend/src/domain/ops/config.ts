// Binds stage0 to env, for the job runtime root. Pure: the root passes `getEnv()` and the
// runtime's fetch and SecretBox in.
import { HttpHeartbeat } from '@backend/domain/ops/heartbeat';

import type { Heartbeat } from '@backend/domain/notification/DeliveryService';
import type { Env } from '@backend/infra/config/env';
import type { SecretBox } from '@backend/infra/crypto/secret-box';

/** What the job runner needs to run stage0. */
export interface Stage0Deps {
  /** The GitHub inbound source the canary is sent to. */
  sourceId: string;
  heartbeat: Heartbeat;
  /** Sends the canary to the app's own ingest route. */
  fetch: typeof fetch;
  /** Opens the canary source's secret, to sign the canary. */
  box: Pick<SecretBox, 'open'>;
}

/** Stage0's deps, or undefined (stage0 off) unless both OPS_HEARTBEAT_URL and
 * OPS_CANARY_SOURCE_ID are set. Only one of them set is logged as a likely mistake. */
// eslint-disable-next-line sonarjs/function-return-type -- undefined is the "not configured" answer
export function stage0FromEnv(
  env: Pick<Env, 'OPS_HEARTBEAT_URL' | 'OPS_CANARY_SOURCE_ID'>,
  runtime: { fetch: typeof fetch; box: Pick<SecretBox, 'open'> },
): Stage0Deps | undefined {
  const { OPS_HEARTBEAT_URL: url, OPS_CANARY_SOURCE_ID: sourceId } = env;
  if (url === undefined || sourceId === undefined) {
    if (url !== undefined || sourceId !== undefined) {
      console.warn('[ops] stage0 is off: set both OPS_HEARTBEAT_URL and OPS_CANARY_SOURCE_ID');
    }
    return undefined;
  }
  return {
    sourceId,
    heartbeat: new HttpHeartbeat({ url, fetch: runtime.fetch }),
    fetch: runtime.fetch,
    box: runtime.box,
  };
}
