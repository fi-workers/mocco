import { InboundOutcomes } from '@mocco/common/inbound';

/** Published receipts one workspace may have in any 24 hours; later deliveries are
 * recorded as `over_quota` (notification relay design §5). */
export const INBOUND_DAILY_LIMIT = 5000;

/**
 * Receipts of any outcome one workspace may have in any 24 hours. Past it, deliveries
 * are refused with 429 and nothing is written, so a flood (or a vendor stuck in a
 * retry loop) cannot grow the receipts table without bound. Well above the daily
 * limit, so ignored and over-quota receipts still show in the trace for a while.
 */
export const INBOUND_HARD_LIMIT = 4 * INBOUND_DAILY_LIMIT;

/** The window `INBOUND_DAILY_LIMIT` and `INBOUND_HARD_LIMIT` count over. */
export const INBOUND_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A receipt still `pending` after this long is republished by `inbound.republish-stale`. */
export const INBOUND_STALE_PENDING_MS = 60 * 1000;

/** Receipts are kept this long (by `received_at`), then `inbound.prune` deletes them. */
export const INBOUND_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Failed publishes after which a pending receipt is given up on (marked ignored). */
export const INBOUND_MAX_PUBLISH_ATTEMPTS = 5;

/** `last_received_at` is written at most this often per source. */
export const INBOUND_LAST_RECEIVED_THROTTLE_MS = 60 * 1000;

/** Largest request body the ingest route reads; a larger one is refused with 413. */
export const INBOUND_MAX_BODY_BYTES = 1024 * 1024;

/** An ingest key: 32 random bytes in base64url (43 characters, no padding). */
export const INGEST_KEY_PATTERN = /^[\w-]{43}$/u;

/** Rows one prune or republish batch touches. */
export const INBOUND_BATCH_SIZE = 1000;

/** Longest vendor delivery id we store; a longer one is treated as missing (400). */
export const INBOUND_EXTERNAL_ID_MAX = 256;

/** Path of the ingest route under the app origin; the ingest key follows it. */
export const INBOUND_INGEST_PATH = '/api/ext/inbound';

/** The subject type of an inbound domain event: the receipt it was published from. */
export const INBOUND_EVENT_SUBJECT = 'inbound_receipt';

/** A delivery's receipt has this dedupe key on its domain event, so a republish
 * (or a redelivery racing a slow original) never publishes it twice. */
export function inboundEventDedupeKey(receiptId: string): string {
  return `inbound:${receiptId}`;
}

/** The SecretBox AAD of a source's sealed secret. */
export function inboundSecretAad(sourceId: string): string {
  return `mocco_inbound_sources:${sourceId}`;
}

/** What `InboundService.ingest` did with an accepted (202) delivery: a stored outcome,
 * or `duplicate` for a redelivery of a delivery id already recorded. */
export const IngestOutcomes = {
  ...InboundOutcomes,
  duplicate: 'duplicate',
} as const;
export type IngestOutcome = (typeof IngestOutcomes)[keyof typeof IngestOutcomes];

/** HTTP status the ingest route answers with. */
export const IngestStatuses = {
  accepted: 202,
  badRequest: 400,
  unauthorized: 401,
  notFound: 404,
  tooManyRequests: 429,
} as const;
