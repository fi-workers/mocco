import { chainEntry } from '@backend/domain/audit/chain';

import type { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import type { AuditAction } from '@mocco/common/audit';

/** What a governed action records — the semantic fields (the DB assigns `seq`/`id`/
 * `created_at`, and the service computes `prev_hash`/`hash`). */
export interface AuditRecordInput {
  actorUserId: string | null;
  action: AuditAction;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
}

/** The result of re-walking a workspace's chain — `brokenAtSeq` is the raw `bigint`
 * `seq` (the router stringifies it for the wire, like every other bigserial). */
export type VerifyResult = { intact: true } | { intact: false; brokenAtSeq: bigint };

/** Entries `verify` reads per round trip — bounds its memory, not its time. */
const VERIFY_PAGE_SIZE = 1000;

export interface AuditServiceDeps {
  audit: AuditRepo;
}

/**
 * The audit log (slice 8, PR1) — append + verify over a per-workspace hash chain.
 * Anemic (ADR 0012): reaches the DB only through the injected repo; the chain math is
 * the pure `chainEntry` SSOT. `record` is **fail-open** (the governed action already
 * happened — an audit failure must never break it, spec §2); `verify` is fail-closed
 * (it reports any break explicitly). The write-path wiring into GateService /
 * CredentialBroker / RunService, and the read surface, land in PR2.
 */
export class AuditService {
  constructor(private readonly deps: AuditServiceDeps) {}

  /**
   * Append an entry to the workspace's chain: read the chain head (`prev_hash`),
   * compute the next `hash` from the semantic content, insert — atomically, so
   * concurrent appends to one workspace link up instead of forking (the repo owns
   * that serialization). Fail-open — any failure is logged and swallowed so the
   * caller (the governed action) is never affected. Never throws.
   */
  async record(workspaceId: string, input: AuditRecordInput): Promise<void> {
    try {
      // The repo holds the per-workspace lock while it reads the head and inserts,
      // and calls back here for the hash once `prevHash` is known — so the chain
      // math stays the pure `chainEntry` SSOT and the linkage stays atomic.
      await this.deps.audit.appendChained(
        workspaceId,
        input,
        prevHash => chainEntry(prevHash, { workspaceId, ...input }).hash,
      );
    } catch (error) {
      // The governed action already happened; audit is a durability best-effort here.
      console.error(`[audit] record failed for workspace ${workspaceId} action ${input.action}`, error);
    }
  }

  /**
   * Re-walk the workspace's chain in `seq` order, recomputing each entry's `hash`
   * from the running `prev` (starting null). The first entry whose stored `prev_hash`
   * doesn't match the running `prev` (a linkage break — a removal or reorder) or
   * whose stored `hash` doesn't match the recomputation (a mutated field) is where
   * the chain stops reconciling; return its `seq`. An empty or fully-reconciling
   * chain is `intact`.
   *
   * The walk reads the chain in keyset pages of `VERIFY_PAGE_SIZE`, carrying only the
   * last stored hash between pages, so memory stays constant however long the chain
   * grows. Time is still linear in the chain, which is why the console runs this on
   * load and on request rather than on a timer.
   *
   * What this cannot see: `seq` gaps are normal (a rolled-back insert still consumes
   * a bigserial value), so contiguity is never checked; and deleting the newest
   * entries leaves a shorter chain that still reconciles — nothing in the database
   * proves a removed tail existed. That needs an external anchor (the deferred KMS
   * signing).
   */
  async verify(workspaceId: string): Promise<VerifyResult> {
    let prev: string | null = null;
    let afterSeq = 0n;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- each page starts after the previous one's last seq
      const page = await this.deps.audit.chainPage(workspaceId, afterSeq, VERIFY_PAGE_SIZE);
      const pagePrev = prev;
      // The running `prev` for entry N is entry N-1's STORED hash — the previous
      // page's last hash for this page's first entry (null for the chain's first).
      const broken = page.find((entry, index) => {
        const expectedPrev = index === 0 ? pagePrev : (page[index - 1]?.hash ?? null);
        const { hash } = chainEntry(expectedPrev, {
          workspaceId: entry.workspaceId,
          actorUserId: entry.actorUserId,
          action: entry.action,
          subjectType: entry.subjectType,
          subjectId: entry.subjectId,
          payload: entry.payload,
        });
        return entry.prevHash !== expectedPrev || entry.hash !== hash;
      });
      if (broken) {
        return { intact: false, brokenAtSeq: broken.seq };
      }
      const last = page.at(-1);
      if (last === undefined || page.length < VERIFY_PAGE_SIZE) {
        return { intact: true };
      }
      prev = last.hash;
      afterSeq = last.seq;
    }
  }

  /** A workspace's entries with `seq > sinceSeq`, oldest-first — the read surface
   * (PR2) consumes this; the router stringifies each `seq` for the wire. */
  async list(workspaceId: string, sinceSeq: bigint) {
    return await this.deps.audit.listByWorkspace(workspaceId, sinceSeq);
  }

  /** A workspace's `limit` newest entries, newest-first — what a summary (Home) shows,
   * without reading the whole chain. */
  async recent(workspaceId: string, limit: number) {
    return await this.deps.audit.latest(workspaceId, limit);
  }
}
