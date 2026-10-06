import { createHash, createHmac } from 'node:crypto';

import { InboundKinds, InboundSourceStatuses } from '@mocco/common/inbound';

import { errorSummary } from '@backend/domain/errors';
import { INBOUND_INGEST_PATH, inboundSecretAad, IngestStatuses } from '@backend/domain/inbound/constants';
import { CanaryRejectedError, CanarySourceError } from '@backend/domain/ops/errors';

import type { InboundSourceRepo } from '@backend/domain/inbound/repos/inbound-source.repo';
import type { SecretBox } from '@backend/infra/crypto/secret-box';

/** How often the stage0 canary is sent. An external monitor with this period and a
 * ten-minute grace alerts at most fifteen minutes after the last canary that got through. */
export const STAGE0_CANARY_INTERVAL_SECONDS = 5 * 60;

/** A canary request that takes longer is abandoned (the job fails and retries). */
export const STAGE0_CANARY_TIMEOUT_MS = 15_000;

/** The repository the synthetic push names (the `repo` fact a rule may filter on). */
export const STAGE0_CANARY_REPO = 'mocco/stage0-canary';

/** The branch the synthetic push is to (the `branch` fact). */
export const STAGE0_CANARY_BRANCH = 'stage0';

export interface Stage0CanaryDeps {
  sources: Pick<InboundSourceRepo, 'findById'>;
  box: Pick<SecretBox, 'open'>;
  /** Sends the canary over HTTP, to the app's own public ingest route. */
  fetch: typeof fetch;
  /** The app's public origin: the canary goes out and comes back in like a vendor's. */
  appOrigin: string;
  /** `OPS_CANARY_SOURCE_ID`: a GitHub inbound source, used for nothing else. */
  sourceId: string;
  now: () => Date;
  timeoutMs?: number;
}

/** A signed canary, as GitHub would send a push to the canary source. */
export interface CanaryRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * The stage0 canary (relay design §11). Every five minutes it sends a synthetic GitHub
 * push, signed with the canary source's secret, to that source's public ingest URL over
 * HTTP, so the route, the function, the DB and the queue all handle it like any vendor's
 * delivery. A rule routes it to a private channel; the Discord sender deletes the
 * message once it posts and then pings the heartbeat (`DeliveryService`). This service
 * only sends: whatever breaks after the 202 shows up as the pings stopping.
 */
export class Stage0CanaryService {
  constructor(private readonly deps: Stage0CanaryDeps) {}

  /** The request for one canary. `deliveryId` is the job's id, so a retried job that
   * already got through is a duplicate receipt instead of a second canary. */
  async build(deliveryId: string): Promise<CanaryRequest> {
    const source = await this.deps.sources.findById(this.deps.sourceId);
    if (source === undefined) {
      throw new CanarySourceError('the stage0 canary source (OPS_CANARY_SOURCE_ID) does not exist');
    }
    if (source.kind !== InboundKinds.github) {
      throw new CanarySourceError('the stage0 canary source must be a GitHub source');
    }
    if (source.status !== InboundSourceStatuses.active) {
      throw new CanarySourceError('the stage0 canary source is paused');
    }
    const secret = this.deps.box.open(source.secretSealed, inboundSecretAad(source.id));
    // A commit-shaped id the message shows (its first seven characters), not a security hash.
    const sha = createHash('sha256').update(deliveryId).digest('hex').slice(0, 40);
    const body = JSON.stringify({
      ref: `refs/heads/${STAGE0_CANARY_BRANCH}`,
      repository: { full_name: STAGE0_CANARY_REPO },
      sender: { login: 'mocco-stage0' },
      commits: [{ id: sha, message: `stage0 canary ${this.deps.now().toISOString()}` }],
    });
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    return {
      url: `${this.deps.appOrigin}${INBOUND_INGEST_PATH}/${source.ingestKey}`,
      body,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mocco-Stage0-Canary',
        'x-github-event': 'push',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': `sha256=${signature}`,
      },
    };
  }

  /** Send one canary. Throws unless the ingest route answers 202. */
  async send(deliveryId: string): Promise<void> {
    const request = await this.build(deliveryId);
    let status: number;
    try {
      const response = await this.deps.fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? STAGE0_CANARY_TIMEOUT_MS),
      });
      await response.body?.cancel();
      ({ status } = response);
    } catch (error) {
      // Only the error's class: the URL carries the ingest key.
      console.error('[ops] sending the stage0 canary failed', errorSummary(error));
      throw new CanaryRejectedError('the stage0 canary got no answer from the ingest route', { cause: error });
    }
    if (status !== IngestStatuses.accepted) {
      console.error(`[ops] the ingest route answered the stage0 canary ${status}`);
      throw new CanaryRejectedError(`the ingest route answered the stage0 canary ${status}`);
    }
  }
}
