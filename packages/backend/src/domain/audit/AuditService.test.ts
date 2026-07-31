import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { eq } from 'drizzle-orm';
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
    return await new AuditRepo(t.db).all(workspaceId);
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
