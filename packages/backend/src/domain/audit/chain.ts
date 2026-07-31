import { createHash } from 'node:crypto';

import type { AuditAction } from '@mocco/common/audit';

/**
 * The pure hash-chain core — the SSOT for how an audit entry is canonicalized and
 * hashed (slice 8, PR1). `AuditService.record` reads the workspace's last hash and
 * calls this to compute the next; `AuditService.verify` re-walks the chain and
 * recomputes each hash from the running `prev`. Pure, exhaustively unit-tested (same
 * input → same hash; key-order-independent; a changed field → a different hash;
 * entry N's hash feeds entry N+1). Mirrors `callback-token.ts` — `node:crypto` only,
 * no DB, no I/O.
 */

/**
 * The semantic (content) fields the hash covers — everything about an entry that a
 * verifier must reproduce, EXCLUDING the DB-assigned `seq`/`created_at`/`id` so the
 * chain is verifiable from content alone (spec §7). `workspaceId` is included, binding
 * each entry to its tenant's chain.
 */
export interface AuditEntryInput {
  workspaceId: string;
  actorUserId: string | null;
  action: AuditAction;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
}

/** A deterministic, locale-independent string order (UTF-16 code-unit comparison) —
 * so the canonical key order is stable across environments (never the default
 * alphabetic sort, never locale-dependent `localeCompare`). */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Deterministic JSON with recursively sorted object keys, so two structurally-equal
 * inputs (any key insertion order, at any depth) produce the identical string. Arrays
 * keep their order (order is meaningful in a list); objects are key-sorted. A stable
 * canonical form is what makes the chain reproducible by any verifier.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // Primitives (string/number/boolean/null). JSON.stringify yields undefined for
    // unsupported values (undefined/function/symbol) — normalize those to null so the
    // form is always a valid, deterministic JSON token.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(element => canonicalize(element)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .toSorted(compareCodeUnits)
    .map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${members.join(',')}}`;
}

/**
 * Canonicalize an entry's semantic fields and chain-hash them onto `prevHash`:
 * `hash = sha-256((prevHash ?? '') || canonical)` (hex). The top-level field order
 * here is irrelevant — `canonicalize` sorts keys deeply, including the arbitrary
 * jsonb `payload` — so the result depends only on content, never insertion order.
 */
export function chainEntry(prevHash: string | null, entry: AuditEntryInput): { canonical: string; hash: string } {
  const canonical = canonicalize({
    workspaceId: entry.workspaceId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    payload: entry.payload,
  });
  const hash = createHash('sha256')
    .update((prevHash ?? '') + canonical)
    .digest('hex');
  return { canonical, hash };
}
