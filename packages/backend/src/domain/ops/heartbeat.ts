// The stage0 heartbeat (relay design §11): one GET to an external dead-man switch (a
// Mocco heartbeat monitor on another install, healthchecks.io, Cronitor, …). It goes
// silent when Mocco does, and that service alerts the team outside Mocco.
import { errorSummary } from '@backend/domain/errors';

import type { Heartbeat } from '@backend/domain/notification/DeliveryService';

/** A ping that takes longer is abandoned; the next canary pings again five minutes later. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

export interface HttpHeartbeatDeps {
  /** The ping URL. It usually carries a token, so it is never logged. */
  url: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}

/** Pings `url` with a GET. Best-effort: a failure is logged without the URL and never thrown. */
export class HttpHeartbeat implements Heartbeat {
  constructor(private readonly deps: HttpHeartbeatDeps) {}

  async ping(): Promise<void> {
    try {
      const response = await this.deps.fetch(this.deps.url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? HEARTBEAT_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (!response.ok) {
        console.error(`[ops] the heartbeat ping was answered ${response.status}`);
      }
    } catch (error) {
      console.error('[ops] the heartbeat ping failed', errorSummary(error));
    }
  }
}
