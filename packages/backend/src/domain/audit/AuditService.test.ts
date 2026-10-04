import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { chainEntry } from '@backend/domain/audit/chain';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

describe('AuditService (pglite)', () => {
  let t: TestDb;
  let service: AuditService;

  beforeEach(async () => {
    t = await createTestDb();
    service = new AuditService({ audit: new AuditRepo(t.db) });
  });
  afterEach(async () => {
    await t.close();
  });

  async function seedWorkspace(name = 'W'): Promise<string> {
    return expectOne(await t.db.insert(workspaces).values({ name, slug: randomUUID() }).returning()).id;
  }

  async function seedUser(): Promise<string> {
    return expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com` })
        .returning(),
    ).id;
  }

  /** The workspace's rows, oldest-first (raw, for asserting the stored chain). */
  async function allRows(workspaceId: string) {
    return await new AuditRepo(t.db).listByWorkspace(workspaceId, 0n);
  }

  /** Record a gate-resumed entry per subjectId, SEQUENTIALLY (head-recursion, not a
   * loop) so the chain builds in a deterministic order. */
  async function recordSubjects(workspaceId: string, subjectIds: string[]): Promise<void> {
    const [head, ...rest] = subjectIds;
    if (head === undefined) {
      return;
    }
    await service.record(workspaceId, {
      actorUserId: null,
      action: AuditActions.gateResumed,
      subjectType: 'run_gate',
      subjectId: head,
      payload: { subjectId: head },
    });
    await recordSubjects(workspaceId, rest);
  }

  it('records the first entry with prev_hash null and a content hash', async () => {
    const workspaceId = await seedWorkspace();
    const actorUserId = await seedUser();

    await service.record(workspaceId, {
      actorUserId,
      action: AuditActions.runTriggered,
      subjectType: 'run',
      subjectId: 'run-1',
      payload: { triggerSource: 'manual' },
    });

    const [entry] = await allRows(workspaceId);
    expect(entry?.prevHash).toBeNull();
    expect(entry?.hash).toBe(
      chainEntry(null, {
        workspaceId,
        actorUserId,
        action: AuditActions.runTriggered,
        subjectType: 'run',
        subjectId: 'run-1',
        payload: { triggerSource: 'manual' },
      }).hash,
    );
  });

  it('links prev_hash across successive appends (each binds to the last)', async () => {
    const workspaceId = await seedWorkspace();

    await service.record(workspaceId, {
      actorUserId: null,
      action: AuditActions.gateResumed,
      subjectType: 'run_gate',
      subjectId: 'g1',
      payload: {},
    });
    await service.record(workspaceId, {
      actorUserId: null,
      action: AuditActions.credentialIssued,
      subjectType: 'run_step',
      subjectId: 's1',
      payload: { provider: 'aws' },
    });
    await service.record(workspaceId, {
      actorUserId: null,
      action: AuditActions.runTriggered,
      subjectType: 'run',
      subjectId: 'r1',
      payload: {},
    });

    const chain = await allRows(workspaceId);
    expect(chain).toHaveLength(3);
    expect(chain[0]?.prevHash).toBeNull();
    // Each entry's prev_hash is its predecessor's hash — a linked chain.
    expect(chain[1]?.prevHash).toBe(chain[0]?.hash);
    expect(chain[2]?.prevHash).toBe(chain[1]?.hash);
    // seq is strictly increasing.
    expect(Number(chain[1]?.seq ?? 0n)).toBeGreaterThan(Number(chain[0]?.seq ?? 0n));
    expect(Number(chain[2]?.seq ?? 0n)).toBeGreaterThan(Number(chain[1]?.seq ?? 0n));
  });

  it('serializes concurrent appends — a raced chain still verifies intact', async () => {
    const workspaceId = await seedWorkspace();

    // Two governed actions land at once (two approvers resuming a gate, or a run
    // trigger racing a credential decision). Both read the chain head and both
    // append; without per-workspace serialization they share one prev_hash and
    // `verify` reports the second as a tamper — a false "Chain broken" on the
    // compliance surface. Each append must bind to the other's hash instead.
    await Promise.all([
      service.record(workspaceId, {
        actorUserId: null,
        action: AuditActions.gateResumed,
        subjectType: 'run_gate',
        subjectId: 'g1',
        payload: {},
      }),
      service.record(workspaceId, {
        actorUserId: null,
        action: AuditActions.runTriggered,
        subjectType: 'run',
        subjectId: 'r1',
        payload: {},
      }),
    ]);

    const chain = await allRows(workspaceId);
    // Neither append was lost (record is fail-open, so a dropped one would be silent).
    expect(chain).toHaveLength(2);
    // Exactly one genesis entry; the other binds to it.
    expect(chain[0]?.prevHash).toBeNull();
    expect(chain[1]?.prevHash).toBe(chain[0]?.hash);
    expect(await service.verify(workspaceId)).toEqual({ intact: true });
  });

  it('verify → intact for a clean chain', async () => {
    const workspaceId = await seedWorkspace();
    await recordSubjects(workspaceId, ['a', 'b', 'c']);
    expect(await service.verify(workspaceId)).toEqual({ intact: true });
  });

  it('verify → intact for an empty chain', async () => {
    expect(await service.verify(await seedWorkspace())).toEqual({ intact: true });
  });

  it('verify pinpoints brokenAtSeq after a payload is mutated directly in the DB', async () => {
    const workspaceId = await seedWorkspace();
    await recordSubjects(workspaceId, ['a', 'b', 'c']);
    const chain = await allRows(workspaceId);
    const tampered = expectOne(chain.slice(1, 2));
    // Mutate the middle entry's payload WITHOUT recomputing its hash — a tamper.
    await t.db
      .update(auditLog)
      .set({ payload: { subjectId: 'HACKED' } })
      .where(eq(auditLog.seq, tampered.seq));

    expect(await service.verify(workspaceId)).toEqual({ intact: false, brokenAtSeq: tampered.seq });
  });

  it('verify pinpoints brokenAtSeq after a hash is mutated directly in the DB', async () => {
    const workspaceId = await seedWorkspace();
    await recordSubjects(workspaceId, ['a', 'b']);
    const chain = await allRows(workspaceId);
    const first = expectOne(chain.slice(0, 1));
    await t.db.update(auditLog).set({ hash: 'deadbeef' }).where(eq(auditLog.seq, first.seq));

    // The first entry's own hash no longer matches its content — broken at seq 1.
    expect(await service.verify(workspaceId)).toEqual({ intact: false, brokenAtSeq: first.seq });
  });

  /** Insert a valid `count`-entry chain in one statement (the hashes computed with the
   * same `chainEntry` SSOT `record` uses) — long enough to span several `verify`
   * pages without paying one transaction per entry. Returns the stored rows. */
  async function seedLongChain(workspaceId: string, count: number) {
    let prevHash: string | null = null;
    const rows = Array.from({ length: count }, (_, index) => {
      const content = {
        workspaceId,
        actorUserId: null,
        action: AuditActions.runTriggered,
        subjectType: 'run',
        subjectId: `r${String(index)}`,
        payload: { index },
      };
      const row = { ...content, prevHash, hash: chainEntry(prevHash, content).hash };
      prevHash = row.hash;
      return row;
    });
    await t.db.insert(auditLog).values(rows);
    return await allRows(workspaceId);
  }

  describe('verify across pages (a chain longer than one read)', () => {
    // verify reads 1000 entries per round trip; 2500 spans three pages.
    const LONG = 2500;

    it('a long, untouched chain verifies intact', async () => {
      const workspaceId = await seedWorkspace();
      await seedLongChain(workspaceId, LONG);
      expect(await service.verify(workspaceId)).toEqual({ intact: true });
    });

    it('a removed entry at a page boundary breaks the next one', async () => {
      const workspaceId = await seedWorkspace();
      const chain = await seedLongChain(workspaceId, LONG);
      // Entry 1000 ends the first page; without it, entry 1001 links to a hash that is
      // no longer there. The walk must carry the previous page's last hash to see it.
      const removed = expectOne(chain.slice(999, 1000));
      const next = expectOne(chain.slice(1000, 1001));
      await t.db.delete(auditLog).where(eq(auditLog.seq, removed.seq));

      expect(await service.verify(workspaceId)).toEqual({ intact: false, brokenAtSeq: next.seq });
    });

    it('a mutated entry on a later page is pinpointed', async () => {
      const workspaceId = await seedWorkspace();
      const chain = await seedLongChain(workspaceId, LONG);
      const tampered = expectOne(chain.slice(2200, 2201));
      await t.db
        .update(auditLog)
        .set({ payload: { index: -1 } })
        .where(eq(auditLog.seq, tampered.seq));

      expect(await service.verify(workspaceId)).toEqual({ intact: false, brokenAtSeq: tampered.seq });
    });
  });

  it('a seq gap alone is not a break — a rolled-back insert leaves one', async () => {
    const workspaceId = await seedWorkspace();
    await recordSubjects(workspaceId, ['a']);
    // Consume a bigserial value without keeping the row, as a rolled-back insert does.
    await t.db.execute(sql`SELECT nextval(pg_get_serial_sequence('mocco_audit_log', 'seq'))`);
    await recordSubjects(workspaceId, ['b']);

    const [first, second] = await allRows(workspaceId);
    expect(Number((second?.seq ?? 0n) - (first?.seq ?? 0n))).toBeGreaterThan(1);
    expect(await service.verify(workspaceId)).toEqual({ intact: true });
  });

  it('known limitation: deleting the newest entry still verifies intact', async () => {
    // A truncated tail is a shorter chain that still reconciles; nothing in the
    // database proves the removed entry existed. Detecting it needs an external
    // anchor (KMS signing, deferred). This pins the documented behaviour.
    const workspaceId = await seedWorkspace();
    await recordSubjects(workspaceId, ['a', 'b', 'c']);
    const chain = await allRows(workspaceId);
    const last = expectOne(chain.slice(-1));
    await t.db.delete(auditLog).where(eq(auditLog.seq, last.seq));

    expect(await service.verify(workspaceId)).toEqual({ intact: true });
  });

  it('record is fail-open — a repo that throws is logged, the caller is unaffected', async () => {
    const boom = new Error('db down');
    const throwingRepo = {
      appendChained: vi.fn().mockRejectedValue(boom),
    } as unknown as AuditRepo;
    const failing = new AuditService({ audit: throwingRepo });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // record must resolve (never throw) even though the repo blew up.
    await expect(
      failing.record(randomUUID(), {
        actorUserId: null,
        action: AuditActions.runTriggered,
        subjectType: 'run',
        subjectId: 'r1',
        payload: {},
      }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledOnce();

    spy.mockRestore();
  });

  it('verify and list are scoped per workspace (tenant isolation)', async () => {
    const workspaceA = await seedWorkspace('A');
    const workspaceB = await seedWorkspace('B');
    await recordSubjects(workspaceA, ['a1']);
    await recordSubjects(workspaceB, ['b1']);

    // Each workspace's list excludes the other's entries.
    const listA = await service.list(workspaceA, 0n);
    const listB = await service.list(workspaceB, 0n);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0]?.subjectId).toBe('a1');
    expect(listB[0]?.subjectId).toBe('b1');

    // Tampering in B doesn't break A's chain — the chains are independent.
    const b1 = expectOne(listB);
    await t.db.update(auditLog).set({ hash: 'deadbeef' }).where(eq(auditLog.seq, b1.seq));
    expect(await service.verify(workspaceA)).toEqual({ intact: true });
    expect(await service.verify(workspaceB)).toEqual({ intact: false, brokenAtSeq: b1.seq });
  });

  it('list honors the sinceSeq cursor', async () => {
    const workspaceId = await seedWorkspace();
    await recordSubjects(workspaceId, ['a', 'b', 'c']);
    const chain = await allRows(workspaceId);
    const firstSeq = expectOne(chain.slice(0, 1)).seq;
    const afterFirst = await service.list(workspaceId, firstSeq);
    expect(afterFirst.map(entry => entry.subjectId)).toEqual(['b', 'c']);
  });
});
