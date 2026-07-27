import { randomUUID } from 'node:crypto';

import { ExecutorIds } from '@mocco/common/execution';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
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

describe('role router on pglite', () => {
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
      waitUntil: () => {
        /* role router tests don't exercise the run loop */
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
    });
    const api = appRouter.createCaller({ auth, workspace, runs, roles, gates, session, headers });
    return { api, userId: session?.user.id ?? '' };
  };

  describe('create / list / delete', () => {
    it('creates a role and returns it (workspaceId present, no leak)', async () => {
      const { api } = await signedInCaller('create@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });

      const { role } = await api.role.create({ workspaceId: ws.id, name: 'deployer' });
      expect(role.name).toBe('deployer');
      expect(role.workspaceId).toBe(ws.id);

      const { roles } = await api.role.list({ workspaceId: ws.id });
      expect(roles.map(r => r.name)).toEqual(['deployer']);
    });

    it('deletes a role', async () => {
      const { api } = await signedInCaller('delete@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const { role } = await api.role.create({ workspaceId: ws.id, name: 'deployer' });

      await api.role.delete({ workspaceId: ws.id, roleId: role.id });
      const { roles } = await api.role.list({ workspaceId: ws.id });
      expect(roles).toHaveLength(0);
    });

    it('deleting an unknown role is NOT_FOUND', async () => {
      const { api } = await signedInCaller('delete-unknown@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      await expect(api.role.delete({ workspaceId: ws.id, roleId: randomUUID() })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('members', () => {
    it('adds, lists, and removes a member', async () => {
      const { api, userId } = await signedInCaller('members@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const { role } = await api.role.create({ workspaceId: ws.id, name: 'deployer' });

      const { member } = await api.role.addMember({ workspaceId: ws.id, roleId: role.id, userId });
      expect(member).toMatchObject({ roleId: role.id, userId });

      const listed = await api.role.listMembers({ workspaceId: ws.id, roleId: role.id });
      expect(listed.members).toHaveLength(1);
      expect(listed.members[0]?.user.id).toBe(userId);

      await api.role.removeMember({ workspaceId: ws.id, roleId: role.id, userId });
      const after = await api.role.listMembers({ workspaceId: ws.id, roleId: role.id });
      expect(after.members).toHaveLength(0);
    });

    it('adding a member to an unknown role is NOT_FOUND', async () => {
      const { api, userId } = await signedInCaller('members-unknown@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      await expect(api.role.addMember({ workspaceId: ws.id, roleId: randomUUID(), userId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('tenant isolation', () => {
    it('a non-member cannot list roles in another workspace (NOT_FOUND)', async () => {
      const owner = await signedInCaller('owner-list@example.com');
      const { workspace: wsA } = await owner.api.workspace.create({ name: 'A' });
      await owner.api.role.create({ workspaceId: wsA.id, name: 'deployer' });

      const stranger = await signedInCaller('stranger-list@example.com');
      await expect(stranger.api.role.list({ workspaceId: wsA.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a non-member cannot create a role in another workspace (NOT_FOUND)', async () => {
      const owner = await signedInCaller('owner-create@example.com');
      const { workspace: wsA } = await owner.api.workspace.create({ name: 'A' });

      const stranger = await signedInCaller('stranger-create@example.com');
      await expect(stranger.api.role.create({ workspaceId: wsA.id, name: 'x' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it("a role belonging to another workspace maps to NOT_FOUND (querying B's own workspaceId with A's roleId)", async () => {
      const ownerA = await signedInCaller('owner-a@example.com');
      const { workspace: wsA } = await ownerA.api.workspace.create({ name: 'A' });
      const { role } = await ownerA.api.role.create({ workspaceId: wsA.id, name: 'deployer' });

      const memberB = await signedInCaller('member-b@example.com');
      const { workspace: wsB } = await memberB.api.workspace.create({ name: 'B' });

      await expect(memberB.api.role.delete({ workspaceId: wsB.id, roleId: role.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
