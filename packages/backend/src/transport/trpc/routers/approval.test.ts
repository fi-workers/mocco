import { randomUUID } from 'node:crypto';

import { ExecutorIds } from '@mocco/common/execution';
import { ApprovalKinds } from '@mocco/common/governance';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { GrantService } from '@backend/domain/credential/GrantService';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import { createTestEventBus } from '@backend/domain/events/testing/event-bus';
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
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { appRouter } from '@backend/transport/trpc/root';
import { contextServices } from '@backend/transport/trpc/testing/context-services';

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

describe('approval router on pglite', () => {
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
      bus: createTestEventBus(t.db),
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
        /* approval router tests don't exercise the run loop */
      },
    });

  const signedInCaller = async (email: string) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    const runs = makeRuns();
    const roles = new RoleService({ roles: new RoleRepo(t.db), memberships: new RoleMembershipRepo(t.db) });
    const gates = new GateService({
      bus: createTestEventBus(t.db),
      runs: new RunRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      memberships: new RoleMembershipRepo(t.db),
      events: new RunEventRepo(t.db),
      resumeRun: async (run, gateItemIndex) => await runs.resumeFromGate(run, gateItemIndex),
      audit: makeAudit(),
    });
    const grants = new GrantService({ grants: new CredentialGrantRepo(t.db) });
    const ctx = {
      ...contextServices(t.db),
      auth,
      workspace,
      runs,
      roles,
      gates,
      grants,
      audit: makeAudit(),
      session,
      headers,
    };
    return { api: appRouter.createCaller(ctx), ctx, userId: session?.user.id ?? '' };
  };

  it('lists, gets and votes on a request; approval maps FORBIDDEN for a voter without the role', async () => {
    const owner = await signedInCaller('owner@example.com');
    const { workspace: ws } = await owner.api.workspace.create({ name: 'W' });
    const { role } = await owner.api.role.create({ workspaceId: ws.id, name: 'release' });
    const request = await owner.ctx.approvals.request(ws.id, {
      kind: ApprovalKinds.review,
      subjectType: 'test.change',
      subjectId: 'x',
      action: { a: 1 },
      requirements: { resume: [{ role: 'release', count: 1 }], prevent_self: false, reason_required: false },
      requestedByUserId: null,
    });

    const { requests } = await owner.api.approval.list({ workspaceId: ws.id });
    expect(requests.map(row => row.id)).toEqual([request.id]);
    await expect(
      owner.api.approval.vote({ workspaceId: ws.id, requestId: request.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await owner.api.role.addMember({ workspaceId: ws.id, roleId: role.id, userId: owner.userId });
    const voted = await owner.api.approval.vote({ workspaceId: ws.id, requestId: request.id, decision: 'approve' });
    expect(voted.request.state).toBe('approved');
    expect(voted.votes).toHaveLength(1);
    await expect(
      owner.api.approval.vote({ workspaceId: ws.id, requestId: request.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('a non-member gets NOT_FOUND on every approval procedure', async () => {
    const owner = await signedInCaller('owner-2@example.com');
    const { workspace: ws } = await owner.api.workspace.create({ name: 'W' });
    const stranger = await signedInCaller('stranger@example.com');
    const requestId = randomUUID();

    await expect(stranger.api.approval.list({ workspaceId: ws.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(stranger.api.approval.get({ workspaceId: ws.id, requestId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      stranger.api.approval.vote({ workspaceId: ws.id, requestId, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
