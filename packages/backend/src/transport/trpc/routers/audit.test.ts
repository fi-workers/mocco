import { AuditActions } from '@mocco/common/audit';
import { ExecutorIds } from '@mocco/common/execution';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { GrantService } from '@backend/domain/credential/GrantService';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import { GateService } from '@backend/domain/governance/GateService';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { RoleService } from '@backend/domain/governance/RoleService';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { appRouter } from '@backend/transport/trpc/root';

const signUpViaHttp = async (auth: AuthService, email: string) => {
  const response = await auth.handler(
    new Request('https://local.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'fixture-password-1', name: 'fixture-user' }),
    }),
  );
  return new Headers({ cookie: response.headers.get('set-cookie') ?? '' });
};

describe('audit router on pglite', () => {
  let t: TestDb;
  let auth: AuthService;
  let workspace: WorkspaceService;

  beforeEach(async () => {
    t = await createTestDb();
    const provider = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
  });
  afterEach(async () => {
    await t.close();
  });

  const makeAudit = (): AuditService => new AuditService({ audit: new AuditRepo(t.db) });

  const makeRuns = (): RunService =>
    new RunService({
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      commits: new CommitRepo(t.db),
      configs: new CommitConfigRepo(t.db),
      executors: new Map([[ExecutorIds.generic, new FakeExecutor()]]),
      callbackUrl: 'http://localhost:3100/api/ext/callback',
      audit: makeAudit(),
      waitUntil: () => {
        /* audit router tests don't exercise the run loop */
      },
    });

  const signedInCaller = async (email: string) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    const runs = makeRuns();
    const roles = new RoleService({ roles: new RoleRepo(t.db), memberships: new RoleMembershipRepo(t.db) });
    const gates = new GateService({
      runs: new RunRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      memberships: new RoleMembershipRepo(t.db),
      events: new RunEventRepo(t.db),
      resumeRun: async (run, gateItemIndex) => await runs.resumeFromGate(run, gateItemIndex),
      audit: makeAudit(),
    });
    const grants = new GrantService({ grants: new CredentialGrantRepo(t.db) });
    return appRouter.createCaller({
      auth,
      workspace,
      runs,
      roles,
      gates,
      grants,
      audit: makeAudit(),
      session,
      headers,
    });
  };

  /** Append entries directly to a workspace's chain (a machine actor, so actorUserId
   * is null — no user FK to seed). Sequential head-recursion keeps the chain order
   * deterministic. */
  const seedEntries = async (workspaceId: string, subjectIds: string[]): Promise<void> => {
    const [head, ...rest] = subjectIds;
    if (head === undefined) {
      return;
    }
    await makeAudit().record(workspaceId, {
      actorUserId: null,
      action: AuditActions.runTriggered,
      subjectType: 'run',
      subjectId: head,
      payload: { subjectId: head },
    });
    await seedEntries(workspaceId, rest);
  };

  describe('list', () => {
    it('returns the workspace chain oldest-first, with seq serialized as a string', async () => {
      const api = await signedInCaller('list@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      await seedEntries(ws.id, ['a', 'b', 'c']);

      const { entries } = await api.audit.list({ workspaceId: ws.id });
      expect(entries.map(entry => entry.subjectId)).toEqual(['a', 'b', 'c']);
      expect(typeof entries[0]?.seq).toBe('string'); // bigserial on the wire
      // The workspaceId is egress-stripped (the read is already workspace-scoped).
      expect(entries[0]).not.toHaveProperty('workspaceId');
    });

    it('honors the sinceSeq cursor', async () => {
      const api = await signedInCaller('cursor@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      await seedEntries(ws.id, ['a', 'b', 'c']);

      const all = await api.audit.list({ workspaceId: ws.id });
      const firstSeq = all.entries[0]?.seq ?? '0';
      const after = await api.audit.list({ workspaceId: ws.id, sinceSeq: firstSeq });
      expect(after.entries.map(entry => entry.subjectId)).toEqual(['b', 'c']);
    });

    it('a non-member cannot read another workspace chain (NOT_FOUND)', async () => {
      const owner = await signedInCaller('owner-list@example.com');
      const { workspace: ws } = await owner.workspace.create({ name: 'A' });
      await seedEntries(ws.id, ['a']);

      const stranger = await signedInCaller('stranger-list@example.com');
      await expect(stranger.audit.list({ workspaceId: ws.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('verify', () => {
    it('reports intact for a real chain', async () => {
      const api = await signedInCaller('verify-ok@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      await seedEntries(ws.id, ['a', 'b', 'c']);

      await expect(api.audit.verify({ workspaceId: ws.id })).resolves.toEqual({ intact: true });
    });

    it('pinpoints brokenAtSeq after a direct DB mutation', async () => {
      const api = await signedInCaller('verify-broken@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      await seedEntries(ws.id, ['a', 'b', 'c']);

      const rows = await new AuditRepo(t.db).all(ws.id);
      const tampered = expectOne(rows.slice(1, 2));
      await t.db
        .update(auditLog)
        .set({ payload: { subjectId: 'HACKED' } })
        .where(eq(auditLog.seq, tampered.seq));

      await expect(api.audit.verify({ workspaceId: ws.id })).resolves.toEqual({
        intact: false,
        brokenAtSeq: tampered.seq.toString(),
      });
    });

    it('a workspace chain is isolated — tampering in one never breaks another (tenant isolation)', async () => {
      const api = await signedInCaller('verify-tenant@example.com');
      const { workspace: wsA } = await api.workspace.create({ name: 'A' });
      const { workspace: wsB } = await api.workspace.create({ name: 'B' });
      await seedEntries(wsA.id, ['a1']);
      await seedEntries(wsB.id, ['b1']);

      const bRow = expectOne(await new AuditRepo(t.db).all(wsB.id));
      await t.db.update(auditLog).set({ hash: 'deadbeef' }).where(eq(auditLog.seq, bRow.seq));

      await expect(api.audit.verify({ workspaceId: wsA.id })).resolves.toEqual({ intact: true });
      await expect(api.audit.verify({ workspaceId: wsB.id })).resolves.toEqual({
        intact: false,
        brokenAtSeq: bRow.seq.toString(),
      });
    });

    it('a non-member cannot verify another workspace chain (NOT_FOUND)', async () => {
      const owner = await signedInCaller('owner-verify@example.com');
      const { workspace: ws } = await owner.workspace.create({ name: 'A' });
      await seedEntries(ws.id, ['a']);

      const stranger = await signedInCaller('stranger-verify@example.com');
      await expect(stranger.audit.verify({ workspaceId: ws.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
