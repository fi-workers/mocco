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
   * whose stored `hash` doesn't match the recomputation (a mutated field) proves a
   * tamper; return its `seq`. An empty or fully-reconciling chain is `intact`.
   */
  async verify(workspaceId: string): Promise<VerifyResult> {
    const entries = await this.deps.audit.all(workspaceId);
    // The running `prev` for entry N is entry N-1's STORED hash (null for the first).
    // The first entry that doesn't reconcile — a broken `prev_hash` linkage (removal/
    // reorder) or a recomputed `hash` mismatch (a mutated field) — proves a tamper.
    const broken = entries.find((entry, index) => {
      const prev = index === 0 ? null : (entries[index - 1]?.hash ?? null);
      const { hash } = chainEntry(prev, {
        workspaceId: entry.workspaceId,
        actorUserId: entry.actorUserId,
        action: entry.action,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        payload: entry.payload,
      });
      return entry.prevHash !== prev || entry.hash !== hash;
    });
    return broken ? { intact: false, brokenAtSeq: broken.seq } : { intact: true };
  }

  /** A workspace's entries with `seq > sinceSeq`, oldest-first — the read surface
   * (PR2) consumes this; the router stringifies each `seq` for the wire. */
  async list(workspaceId: string, sinceSeq: bigint) {
    return await this.deps.audit.listByWorkspace(workspaceId, sinceSeq);
  }
}
