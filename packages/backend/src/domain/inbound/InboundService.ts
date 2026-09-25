import { inboundEventPayloadSchema } from '@mocco/common/events';
import { inboundEventTypeSchema, InboundOutcomes, InboundSourceStatuses } from '@mocco/common/inbound';

import { DomainEventPayloadError, UnknownDomainEventTypeError } from '@backend/domain/events/errors';
import {
  INBOUND_BATCH_SIZE,
  INBOUND_DAILY_LIMIT,
  INBOUND_EVENT_SUBJECT,
  INBOUND_EXTERNAL_ID_MAX,
  INBOUND_HARD_LIMIT,
  INBOUND_LAST_RECEIVED_THROTTLE_MS,
  INBOUND_MAX_PUBLISH_ATTEMPTS,
  INBOUND_QUOTA_WINDOW_MS,
  INBOUND_RECEIPT_RETENTION_MS,
  INBOUND_STALE_PENDING_MS,
  inboundEventDedupeKey,
  inboundSecretAad,
  IngestOutcomes,
  IngestStatuses,
  type IngestOutcome,
} from '@backend/domain/inbound/constants';
import { sourceAdapters } from '@backend/domain/inbound/sources/adapters';
import {
  decodeBody,
  IgnoredReasons,
  ParsedInboundKinds,
  sanitize,
  type ParsedInbound,
} from '@backend/domain/inbound/sources/shared';

import type { EventPublisher } from '@backend/domain/events/ports';
import type {
  InboundReceiptRepo,
  InboundReceiptRow,
  ReceiptListFilter,
} from '@backend/domain/inbound/repos/inbound-receipt.repo';
import type { InboundSourceRepo, InboundSourceRow } from '@backend/domain/inbound/repos/inbound-source.repo';
import type { SecretBox } from '@backend/infra/crypto/secret-box';
import type { InboundEventPayload } from '@mocco/common/events';
import type { InboundReceiptDto } from '@mocco/common/inbound';

export interface InboundServiceDeps {
  sources: InboundSourceRepo;
  receipts: InboundReceiptRepo;
  box: Pick<SecretBox, 'open'>;
  bus: EventPublisher;
  now: () => Date;
}

export interface IngestRequest {
  ingestKey: string;
  /** The exact bytes received: signatures are computed over them. */
  body: Uint8Array;
  headers: Headers;
}

/** What the ingest route answers. Only an accepted delivery carries an outcome. */
export type IngestResult =
  | { status: typeof IngestStatuses.accepted; outcome: IngestOutcome }
  | {
      status:
        | typeof IngestStatuses.badRequest
        | typeof IngestStatuses.unauthorized
        | typeof IngestStatuses.notFound
        | typeof IngestStatuses.tooManyRequests;
    };

export interface ReceiptsPage {
  receipts: InboundReceiptDto[];
  nextCursor: string | null;
}

type ParsedEvent = Extract<ParsedInbound, { kind: typeof ParsedInboundKinds.event }>;

const overQuotaReason = `workspace is over the daily limit of ${INBOUND_DAILY_LIMIT} events`;
const unparseableReason = 'stored event no longer matches the event catalog';
const givenUpReason = `publishing failed ${INBOUND_MAX_PUBLISH_ATTEMPTS} times`;

/**
 * What a log line may say about an error: its class and a driver error code, never the
 * message or the error itself (a query error's message and params carry the ingest
 * key, the payload or a sealed secret).
 */
export function errorSummary(error: unknown): { error: string; code?: string } {
  const name = error instanceof Error ? error.name : 'unknown error';
  const { cause } = error instanceof Error ? error : { cause: undefined };
  const code: unknown = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' ? { error: name, code } : { error: name };
}

/** A publish that can never succeed, however often it is retried. */
function isDeterministic(error: unknown): boolean {
  return error instanceof DomainEventPayloadError || error instanceof UnknownDomainEventTypeError;
}

/** The vendor's delivery id as stored, or undefined when it is missing or unusable. */
function cleanExternalId(value: string | undefined): string | undefined {
  const clean = value === undefined ? '' : sanitize(value).trim();
  // sonarjs/null-dereference is a false positive: `clean` is always a string.
  // eslint-disable-next-line sonarjs/null-dereference
  return clean === '' || clean.length > INBOUND_EXTERNAL_ID_MAX ? undefined : clean;
}

/** The event payload a mapped delivery is stored with, and later published as. */
function normalized(source: InboundSourceRow, event: ParsedEvent): InboundEventPayload {
  return { sourceId: source.id, facts: event.facts, message: event.message };
}

/**
 * The inbound webhook pipeline (notification relay design §5, ADR 0019): a delivery
 * to `/api/ext/inbound/<ingestKey>` is verified against its source's sealed secret,
 * recorded as a receipt (deduped by the vendor's delivery id), checked against the
 * workspace's daily quota, and published as a domain event keyed by its receipt.
 *
 * `ingest` never throws for anything a vendor sends: a bad signature, a missing id or
 * an unparseable body all become a status or an `ignored` receipt. Only an internal
 * failure (the DB, a secret that no longer opens) throws, and the route turns that
 * into a bare 500.
 */
export class InboundService {
  /** When the hard ceiling was last logged per workspace, so a flood logs once per window. */
  private readonly ceilingLoggedAt = new Map<string, number>();

  constructor(private readonly deps: InboundServiceDeps) {}

  /** Log that a workspace hit the hard ceiling, at most once per quota window. */
  private logCeiling(workspaceId: string, at: Date): void {
    const last = this.ceilingLoggedAt.get(workspaceId);
    if (last !== undefined && at.getTime() - last < INBOUND_QUOTA_WINDOW_MS) {
      return;
    }
    this.ceilingLoggedAt.set(workspaceId, at.getTime());
    console.warn('[inbound] workspace is over the hard receipt limit; deliveries are refused', {
      workspaceId,
      limit: INBOUND_HARD_LIMIT,
    });
  }

  /** Open a source's secret. A failure (a key no longer configured, a tampered value) is
   * logged with the source id only and rethrown: the route answers 500. */
  private openSecret(source: InboundSourceRow): string {
    try {
      return this.deps.box.open(source.secretSealed, inboundSecretAad(source.id));
    } catch (error) {
      console.error('[inbound] opening the source secret failed', { sourceId: source.id, ...errorSummary(error) });
      throw error;
    }
  }

  /** Throttled and best-effort: a failure here never fails a recorded delivery. */
  private async touchLastReceived(sourceId: string, at: Date): Promise<void> {
    try {
      await this.deps.sources.touchLastReceived(sourceId, at, INBOUND_LAST_RECEIVED_THROTTLE_MS);
    } catch (error) {
      console.error('[inbound] updating last_received_at failed', { sourceId, ...errorSummary(error) });
    }
  }

  /**
   * After a failed publish: count it, and give up on the receipt (ignored, with the
   * reason) when the failure is deterministic or has happened too often, so it cannot
   * hold the republish scan forever. Best-effort itself.
   */
  private async recordPublishFailure(receipt: InboundReceiptRow, error: unknown): Promise<void> {
    console.error('[inbound] publishing a receipt failed', {
      receiptId: receipt.id,
      sourceId: receipt.sourceId,
      ...errorSummary(error),
    });
    try {
      const attempts = await this.deps.receipts.recordPublishFailure(receipt.id);
      if (isDeterministic(error)) {
        await this.deps.receipts.markDropped(receipt.id, InboundOutcomes.ignored, unparseableReason);
      } else if (attempts >= INBOUND_MAX_PUBLISH_ATTEMPTS) {
        await this.deps.receipts.markDropped(receipt.id, InboundOutcomes.ignored, givenUpReason);
      }
    } catch (error_) {
      console.error('[inbound] recording a publish failure failed', {
        receiptId: receipt.id,
        ...errorSummary(error_),
      });
    }
  }

  /**
   * Publish a pending receipt's event and mark the receipt published. The event's
   * dedupe key is the receipt id, so publishing the same receipt again (a republish
   * racing a slow original) returns the same event. A stored payload that no longer
   * parses is marked ignored instead.
   */
  private async publish(receipt: InboundReceiptRow): Promise<void> {
    const type = inboundEventTypeSchema.safeParse(receipt.eventType);
    const payload = inboundEventPayloadSchema.safeParse(receipt.normalized);
    if (!type.success || !payload.success) {
      await this.deps.receipts.markDropped(receipt.id, InboundOutcomes.ignored, unparseableReason);
      return;
    }
    const { event } = await this.deps.bus.publish({
      type: type.data,
      workspaceId: receipt.workspaceId,
      subject: { type: INBOUND_EVENT_SUBJECT, id: receipt.id },
      payload: payload.data,
      occurredAt: receipt.receivedAt,
      dedupeKey: inboundEventDedupeKey(receipt.id),
    });
    await this.deps.receipts.markPublished(receipt.id, event.id);
  }

  async ingest(request: IngestRequest): Promise<IngestResult> {
    const source = await this.deps.sources.findByIngestKey(request.ingestKey);
    if (source?.status !== InboundSourceStatuses.active) {
      return { status: IngestStatuses.notFound };
    }
    const adapter = sourceAdapters[source.kind];
    const secret = this.openSecret(source);
    if (!adapter.verify(request.body, request.headers, secret)) {
      return { status: IngestStatuses.unauthorized };
    }
    const text = decodeBody(request.body);
    const externalId = cleanExternalId(adapter.deliveryId(text ?? '', request.headers));
    if (externalId === undefined) {
      return { status: IngestStatuses.badRequest };
    }
    const parsed: ParsedInbound =
      text === undefined
        ? { kind: ParsedInboundKinds.ignored, reason: IgnoredReasons.invalidUtf8 }
        : adapter.parse(text, request.headers);
    const event = parsed.kind === ParsedInboundKinds.event ? parsed : undefined;
    const receivedAt = this.deps.now();
    const windowStart = new Date(receivedAt.getTime() - INBOUND_QUOTA_WINDOW_MS);
    // The hard ceiling, before anything is written: a flood stops growing the table.
    if ((await this.deps.receipts.countSince(source.workspaceId, windowStart)) >= INBOUND_HARD_LIMIT) {
      this.logCeiling(source.workspaceId, receivedAt);
      return { status: IngestStatuses.tooManyRequests };
    }
    const receipt = await this.deps.receipts.insertIfNew({
      workspaceId: source.workspaceId,
      sourceId: source.id,
      externalId,
      sourceEvent: text === undefined ? null : (adapter.sourceEvent(text, request.headers) ?? null),
      receivedAt,
      // An event is recorded pending with its payload; anything else as ignored.
      outcome: event === undefined ? InboundOutcomes.ignored : InboundOutcomes.pending,
      reason: parsed.kind === ParsedInboundKinds.ignored ? parsed.reason : null,
      eventType: event?.type ?? null,
      normalized: event === undefined ? null : normalized(source, event),
    });
    await this.touchLastReceived(source.id, receivedAt);
    if (receipt === undefined) {
      return { status: IngestStatuses.accepted, outcome: IngestOutcomes.duplicate };
    }
    if (receipt.outcome === InboundOutcomes.ignored) {
      return { status: IngestStatuses.accepted, outcome: IngestOutcomes.ignored };
    }
    // Soft: two concurrent deliveries can both pass the count and overshoot by a few.
    const published = await this.deps.receipts.countPublishedSince(source.workspaceId, windowStart);
    if (published >= INBOUND_DAILY_LIMIT) {
      await this.deps.receipts.markDropped(receipt.id, InboundOutcomes.over_quota, overQuotaReason);
      return { status: IngestStatuses.accepted, outcome: IngestOutcomes.over_quota };
    }
    try {
      await this.publish(receipt);
    } catch (error) {
      // Recorded and still pending: `inbound.republish-stale` publishes it. The
      // delivery is accepted, since 202 means "recorded".
      await this.recordPublishFailure(receipt, error);
      return { status: IngestStatuses.accepted, outcome: IngestOutcomes.pending };
    }
    return { status: IngestStatuses.accepted, outcome: IngestOutcomes.published };
  }

  /**
   * Publish receipts left pending for longer than `INBOUND_STALE_PENDING_MS` (a crash
   * or a failed publish after recording). The quota is not checked again: a pending
   * receipt already passed it, or was recorded before the check. A failing receipt is
   * counted and skipped; the scan takes the fewest failures first, and a receipt that
   * failed `INBOUND_MAX_PUBLISH_ATTEMPTS` times (or can never publish) is marked
   * ignored, so a stuck batch never starves newer receipts. Returns how many were
   * published or settled.
   */
  async republishStale(options: { deadline?: Date } = {}): Promise<number> {
    const before = new Date(this.deps.now().getTime() - INBOUND_STALE_PENDING_MS);
    const stale = await this.deps.receipts.listPendingBefore(before, INBOUND_BATCH_SIZE);
    const settled = await stale.reduce(async (previous, receipt) => {
      const done = await previous;
      if (options.deadline !== undefined && this.deps.now() >= options.deadline) {
        return done;
      }
      try {
        await this.publish(receipt);
        return done + 1;
      } catch (error) {
        await this.recordPublishFailure(receipt, error);
        return done;
      }
    }, Promise.resolve(0));
    return settled;
  }

  /** Delete receipts older than `INBOUND_RECEIPT_RETENTION_MS`, batch by batch, until
   * none are left or `deadline` has passed. */
  async pruneReceipts(options: { deadline?: Date; batchSize?: number } = {}): Promise<number> {
    const { batchSize = INBOUND_BATCH_SIZE } = options;
    const before = new Date(this.deps.now().getTime() - INBOUND_RECEIPT_RETENTION_MS);
    const pruneFrom = async (total: number): Promise<number> => {
      const deleted = await this.deps.receipts.pruneBefore(before, batchSize);
      const isPastDeadline = options.deadline !== undefined && this.deps.now() >= options.deadline;
      return deleted === batchSize && !isPastDeadline ? await pruneFrom(total + deleted) : total + deleted;
    };
    return await pruneFrom(0);
  }

  /** A page of the workspace's receipts, newest first (the activity trace). */
  async listReceipts(
    workspaceId: string,
    filter: Omit<ReceiptListFilter, 'beforeSeq'> & { beforeSeq?: string },
  ): Promise<ReceiptsPage> {
    const rows = await this.deps.receipts.listByWorkspace(workspaceId, {
      ...filter,
      beforeSeq: filter.beforeSeq === undefined ? undefined : BigInt(filter.beforeSeq),
    });
    const receipts = rows.map(row => ({
      seq: row.seq.toString(),
      id: row.id,
      sourceId: row.sourceId,
      externalId: row.externalId,
      sourceEvent: row.sourceEvent,
      outcome: row.outcome,
      reason: row.reason,
      eventType: row.eventType,
      domainEventId: row.domainEventId,
      receivedAt: row.receivedAt,
    }));
    const last = receipts.at(-1);
    return { receipts, nextCursor: receipts.length === filter.limit && last !== undefined ? last.seq : null };
  }
}
