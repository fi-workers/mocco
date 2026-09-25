// Binds stage0 to env, for the composition roots (runtime/jobs.ts, events/instance.ts).
// Pure: the roots pass `getEnv()` in.
import type { Env } from '@backend/infra/config/env';

/** Stage0 as configured: on only when both OPS_* vars are set. */
export interface Stage0Config {
  /** The inbound source (kind github) the canary is sent to. */
  canarySourceId: string;
  /** The external dead-man switch pinged when a canary reaches Discord. */
  heartbeatUrl: string;
  /** SERVICE_DOMAIN: the only host the canary is ever POSTed to. Undefined when unset,
   * which fails every canary (and so stops the heartbeat) instead of guessing a host. */
  serviceDomain: string | undefined;
}

/** Stage0's config, or undefined (stage0 off) unless OPS_CANARY_SOURCE_ID and
 * OPS_HEARTBEAT_URL are both set. */
// eslint-disable-next-line sonarjs/function-return-type -- undefined is the "stage0 off" answer
export function stage0ConfigFromEnv(
  env: Pick<Env, 'OPS_CANARY_SOURCE_ID' | 'OPS_HEARTBEAT_URL' | 'SERVICE_DOMAIN'>,
): Stage0Config | undefined {
  if (env.OPS_CANARY_SOURCE_ID === undefined || env.OPS_HEARTBEAT_URL === undefined) {
    return undefined;
  }
  return {
    canarySourceId: env.OPS_CANARY_SOURCE_ID,
    heartbeatUrl: env.OPS_HEARTBEAT_URL,
    serviceDomain: env.SERVICE_DOMAIN,
  };
}
