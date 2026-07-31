/**
 * Postgres advisory-lock namespaces — the registry every `pg_advisory_xact_lock`
 * caller draws from. Advisory locks share one global keyspace per cluster, so two
 * unrelated features that both hash a uuid into it would block each other for no
 * reason. The two-argument form partitions that keyspace: the first argument is a
 * namespace from here, the second is the per-subject key (typically
 * `hashtext(<uuid>)`).
 *
 * Always use the `_xact_` variant. Production points `DATABASE_URL` at Supabase's
 * transaction pooler (see `client.ts`), where a connection is not sticky across
 * statements — a session-level `pg_advisory_lock` could be taken on one backend and
 * released on another, or leak entirely. A transaction-scoped lock is held for the
 * transaction the pooler keeps on a single backend, and is released on commit or
 * rollback (including a crashed request).
 *
 * Add a new namespace here rather than inlining an integer at the call site.
 */
export const AdvisoryLockNamespaces = {
  /** Serializes appends to one workspace's audit hash chain (`AuditRepo.appendChained`). */
  auditChain: 1,
} as const;
export type AdvisoryLockNamespace = (typeof AdvisoryLockNamespaces)[keyof typeof AdvisoryLockNamespaces];
