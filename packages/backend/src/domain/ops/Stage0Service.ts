import { InboundKinds, InboundSourceStatuses } from '@mocco/common/inbound';

import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { inboundSecretAad } from '@backend/domain/inbound/constants';
import { errorSummary } from '@backend/domain/inbound/InboundService';
import { DiscordResultKinds } from '@backend/domain/notification/senders/discord';
import { buildCanaryRequest, canaryIdAt, canaryIngestUrl } from '@backend/domain/ops/canary';
import {
  CanaryOutcomes,
  CanaryReasons,
  Stage0Canary,
  Stage0Policy,
  type CanaryOutcome,
} from '@backend/domain/ops/constants';

import type { InboundSourceRepo, InboundSourceRow } from '@backend/domain/inbound/repos/inbound-source.repo';
import type { SentDelivery } from '@backend/domain/notification/DeliveryService';
import type { DiscordApi } from '@backend/domain/notification/senders/discord';
import type { Stage0Config } from '@backend/domain/ops/config';
import type { OpsCanaryRepo } from '@backend/domain/ops/repos/ops-canary.repo';
import type { SecretBox } from '@backend/infra/crypto/secret-box';

/** The part of the Discord client the canary needs: it deletes the message it posted. */
export type Stage0Discord = Pick<DiscordApi, 'deleteMessage'>;

/** Stage0 as the runtime binds it: its config and the fetch it sends with. */
export interface Stage0Runtime {
  config: Stage0Config;
  /** Sends the canary to the ingest route and pings the heartbeat (real HTTP). */
  fetch: typeof fetch;
}

export interface Stage0ServiceDeps {
  /** Undefined when stage0 is off: every call is a no-op. */
  stage0: Stage0Runtime | undefined;
  sources: Pick<InboundSourceRepo, 'findById'>;
  box: Pick<SecretBox, 'open'>;
  canaries: OpsCanaryRepo;
  /** Undefined without DISCORD_BOT_TOKEN (then no canary is ever sent to Discord). */
  discord: Stage0Discord | undefined;
}

export interface CanaryAttempt {
  outcome: CanaryOutcome;
  canaryId?: string;
  /** The ingest route's HTTP status, when it answered. */
  status?: number;
  reason?: string;
}

interface Refusal {
  refused: string;
}

/** The source when it can take a canary, or why not. */
// eslint-disable-next-line sonarjs/function-return-type -- the source, or the one Refusal shape
function checkSource(source: InboundSourceRow | undefined): InboundSourceRow | Refusal {
  if (source === undefined) {
    return { refused: CanaryReasons.sourceNotFound };
  }
  if (source.kind !== InboundKinds.github) {
    return { refused: CanaryReasons.sourceNotGithub };
  }
  if (source.status !== InboundSourceStatuses.active) {
    return { refused: CanaryReasons.sourcePaused };
  }
  return source;
}

/** POST the canary; the status, or why there is none. Redirects are not followed:
 * the guard checked this URL, not wherever a 3xx points. */
async function postCanary(
  fetchImpl: typeof fetch,
  url: string,
  request: { body: Uint8Array; headers: Headers },
): Promise<number | string> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: request.headers,
      body: new Uint8Array(request.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(Stage0Policy.ingestTimeoutMs),
    });
    await response.arrayBuffer();
    return response.status;
  } catch (error) {
    return CanaryReasons.ingestUnreachable(error instanceof Error ? error.name : 'unknown error');
  }
}

/** GET the heartbeat URL; its status, or undefined when it never answered. Never
 * throws, and never logs the URL (a ping URL is a credential for its check). */
async function pingHeartbeat(stage0: Stage0Runtime): Promise<number | undefined> {
  try {
    const response = await stage0.fetch(stage0.config.heartbeatUrl, {
      method: 'GET',
      headers: { 'user-agent': Stage0Canary.userAgent },
      signal: AbortSignal.timeout(Stage0Policy.heartbeatTimeoutMs),
    });
    await response.arrayBuffer();
    if (!response.ok) {
      console.error(`[stage0] the heartbeat answered ${response.status}`);
    }
    return response.status;
  } catch (error) {
    console.error('[stage0] the heartbeat ping failed', { error: error instanceof Error ? error.name : 'unknown' });
    return undefined;
  }
}

/**
 * The stage0 watchdog (notification relay design §11, ADR 0020,
 * docs/reference/ops-stage0.md). `sendCanary` POSTs a signed synthetic GitHub delivery
 * over real HTTP to the canary source's public ingest URL, so the route, the function,
 * the DB, the queue and the Discord sender all have to work for it to arrive. When its
 * delivery is `sent`, `onDelivered` deletes the Discord message and pings the external
 * heartbeat. That ping is the only one: whatever breaks on the way stops it, and the
 * external check alerts the team outside Mocco.
 *
 * Neither method throws for an expected failure; each records what happened in
 * `mocco_ops_canaries` and logs it.
 */
export class Stage0Service {
  constructor(private readonly deps: Stage0ServiceDeps) {}

  private async record(
    canaryId: string,
    sourceId: string,
    sentAt: Date,
    result: { ingestStatus: number | null; error: string | null },
  ): Promise<void> {
    await this.deps.canaries.record({ canaryId, sourceId, sentAt, ...result });
  }

  /** Open the canary source's secret, or undefined when it does not open (logged). */
  private openSecret(source: InboundSourceRow): string | undefined {
    try {
      return this.deps.box.open(source.secretSealed, inboundSecretAad(source.id));
    } catch (error) {
      console.error('[stage0] opening the canary source secret failed', {
        sourceId: source.id,
        ...errorSummary(error),
      });
      return undefined;
    }
  }

  /** The canary record's id, or undefined (no record, or the write failed: logged). */
  private async markDelivered(sent: SentDelivery): Promise<string | undefined> {
    try {
      const row = await this.deps.canaries.markDeliveredByEvent(sent.delivery.eventId, sent.now);
      return row?.id;
    } catch (error) {
      console.error('[stage0] recording the canary delivery failed', {
        deliveryId: sent.delivery.id,
        ...errorSummary(error),
      });
      return undefined;
    }
  }

  /** Best-effort: a canary message left behind in the private channel is harmless. */
  private async deleteMessage(sent: SentDelivery): Promise<void> {
    const { discord } = this.deps;
    if (discord === undefined) {
      return;
    }
    const result = await discord.deleteMessage(sent.channel.externalId, sent.messageId);
    if (result.kind !== DiscordResultKinds.deleted) {
      console.warn('[stage0] deleting the canary message failed', {
        deliveryId: sent.delivery.id,
        kind: result.kind,
        ...('reason' in result && { reason: result.reason }),
      });
    }
  }

  /** Send one canary. Records the attempt; a refused or failed canary is logged as an
   * error (its heartbeat will not come). */
  async sendCanary(now: Date): Promise<CanaryAttempt> {
    const { stage0 } = this.deps;
    if (stage0 === undefined) {
      return { outcome: CanaryOutcomes.disabled };
    }
    const { canarySourceId, serviceDomain } = stage0.config;
    const canaryId = canaryIdAt(now);
    const refuse = async (reason: string): Promise<CanaryAttempt> => {
      console.error(`[stage0] canary ${canaryId} not sent: ${reason}`);
      await this.record(canaryId, canarySourceId, now, { ingestStatus: null, error: reason });
      return { outcome: CanaryOutcomes.refused, canaryId, reason };
    };
    const source = checkSource(await this.deps.sources.findById(canarySourceId));
    if ('refused' in source) {
      return await refuse(source.refused);
    }
    const target = canaryIngestUrl(serviceDomain, source.ingestKey);
    if ('refused' in target) {
      return await refuse(target.refused);
    }
    const secret = this.openSecret(source);
    if (secret === undefined) {
      return await refuse(CanaryReasons.secretUnavailable);
    }
    const request = buildCanaryRequest({ canaryId, secret, appOrigin: resolveBaseOrigin({ serviceDomain }) });
    const status = await postCanary(stage0.fetch, target.url, request);
    if (typeof status === 'string') {
      console.error(`[stage0] canary ${canaryId} failed: ${status}`);
      await this.record(canaryId, canarySourceId, now, { ingestStatus: null, error: status });
      return { outcome: CanaryOutcomes.failed, canaryId, reason: status };
    }
    if (status !== 202) {
      const reason = CanaryReasons.ingestStatus(status);
      console.error(`[stage0] canary ${canaryId} failed: ${reason}`);
      await this.record(canaryId, canarySourceId, now, { ingestStatus: status, error: reason });
      return { outcome: CanaryOutcomes.failed, canaryId, status, reason };
    }
    await this.record(canaryId, canarySourceId, now, { ingestStatus: status, error: null });
    return { outcome: CanaryOutcomes.accepted, canaryId, status };
  }

  /**
   * A delivery was sent. For a canary (marked at fan-out): record it delivered, delete
   * the Discord message, and ping the heartbeat. Anything else is ignored. The ping
   * happens here and nowhere else, which is the invariant stage0 rests on.
   */
  async onDelivered(sent: SentDelivery): Promise<void> {
    const { stage0 } = this.deps;
    if (stage0 === undefined || !sent.delivery.canary) {
      return;
    }
    const canary = await this.markDelivered(sent);
    await this.deleteMessage(sent);
    const status = await pingHeartbeat(stage0);
    if (canary !== undefined) {
      await this.deps.canaries.recordHeartbeat(canary, sent.now, status ?? null);
    }
  }

  /** Delete canary records older than the retention. */
  async pruneCanaries(now: Date): Promise<number> {
    return await this.deps.canaries.pruneBefore(new Date(now.getTime() - Stage0Policy.retentionMs));
  }
}
