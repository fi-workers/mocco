import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ApprovalKinds, ApprovalStates } from '@mocco/common/governance';
import { VersionPolicyOutcomes } from '@mocco/common/ota';
import { AppPlatforms } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { SelfApprovalError } from '@backend/domain/governance/errors';
import { createApprovalService } from '@backend/domain/governance/instance';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { NotAStoreAppError, StoreLiveAttestationRequiredError } from '@backend/domain/ota/errors';
import { createOtaDomain } from '@backend/domain/ota/instance';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { VersionPolicyService } from '@backend/domain/ota/VersionPolicyService';
import type { VersionPolicyRules } from '@mocco/common/ota';

const rules = (overrides: Partial<VersionPolicyRules> = {}): VersionPolicyRules => ({
  minSupportedVersion: '2.0.0',
  recommendedVersion: '2.4.0',
  blockedVersions: [],
  messages: { en: { title: 'Update available', body: 'Please update the app.', action: 'Update' } },
  storeUrl: 'https://apps.apple.com/app/id123456789',
  softPromptIntervalHours: 72,
  approvalPolicy: null,
  ...overrides,
});
const gate = { resume: [{ role: 'release', count: 1 }], prevent_self: true, reason_required: false };

describe('VersionPolicyService (pglite)', () => {
  let t: TestDb;
  let audit: AuditService;
  let approvals: ApprovalService;
  let service: VersionPolicyService;
  let workspaceId: string;
  let projectId: string;
  let appId: string;
  let requester: string;
  let approver: string;

  async function seedUser(role?: string): Promise<string> {
    const [user] = await t.db
      .insert(users)
      .values({ email: `${randomUUID()}@example.com`, name: 'U' })
      .returning();
    const userId = expectOne(user === undefined ? [] : [user]).id;
    if (role !== undefined) {
      const roles = new RoleRepo(t.db);
      const existing = await roles.listByWorkspace(workspaceId);
      const found =
        existing.find(candidate => candidate.name === role) ?? (await roles.create({ workspaceId, name: role }));
      await new RoleMembershipRepo(t.db).add({ workspaceId, roleId: found.id, userId });
    }
    return userId;
  }

  async function currentRevision() {
    const policy = await service.get(workspaceId, projectId, appId);
    return policy?.revision ?? 0;
  }

  beforeEach(async () => {
    t = await createTestDb();
    audit = new AuditService({ audit: new AuditRepo(t.db) });
    const project = createProjectDomain(t.db);
    approvals = createApprovalService(t.db, audit);
    service = createOtaDomain(t.db, { projects: project.projects, approvals, audit }).versionPolicies;
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const created = await project.projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = created.id;
    const app = await project.projects.addApp(workspaceId, projectId, {
      platform: AppPlatforms.ios,
      name: 'Acme iOS',
      bundleId: 'com.acme',
    });
    appId = app.id;
    requester = await seedUser('release');
    approver = await seedUser('release');
  });
  afterEach(async () => {
    await t.close();
  });

  it('applies the first policy at once, records history and audit', async () => {
    const result = await service.change(workspaceId, projectId, appId, requester, {
      rules: rules(),
      storeLiveAttested: true,
    });
    expect(result).toMatchObject({ outcome: VersionPolicyOutcomes.applied, requestId: null });
    expect(result.policy).toMatchObject({ minSupportedVersion: '2.0.0', revision: 1 });

    const history = await service.listChanges(workspaceId, projectId, appId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ direction: 'tighten', before: null, approvalRequestId: null });
    const entries = await audit.list(workspaceId, 0n);
    expect(entries.map(entry => entry.action)).toContain(AuditActions.versionPolicyChanged);
  });

  it('requires the store-live attestation to raise a version floor', async () => {
    await expect(
      service.change(workspaceId, projectId, appId, requester, { rules: rules(), storeLiveAttested: false }),
    ).rejects.toBeInstanceOf(StoreLiveAttestationRequiredError);
  });

  it('refuses a policy on a non-store app', async () => {
    const project = createProjectDomain(t.db);
    const web = await project.projects.addApp(workspaceId, projectId, { platform: AppPlatforms.web, name: 'Site' });
    await expect(service.get(workspaceId, projectId, web.id)).rejects.toBeInstanceOf(NotAStoreAppError);
  });

  describe('under an approval policy', () => {
    beforeEach(async () => {
      await service.change(workspaceId, projectId, appId, requester, {
        rules: rules({ approvalPolicy: gate }),
        storeLiveAttested: true,
      });
    });

    it('gates a tightening change and applies it on approval, linked to the approval', async () => {
      const result = await service.change(workspaceId, projectId, appId, requester, {
        rules: rules({ approvalPolicy: gate, minSupportedVersion: '2.1.0' }),
        storeLiveAttested: true,
        reason: 'crash in 2.0.x',
      });
      expect(result.outcome).toBe(VersionPolicyOutcomes.pendingApproval);
      expect(await currentRevision()).toBe(1);

      const requestId = result.requestId ?? '';
      await expect(approvals.vote(workspaceId, requestId, requester, 'approve')).rejects.toBeInstanceOf(
        SelfApprovalError,
      );
      await approvals.vote(workspaceId, requestId, approver, 'approve');

      const policy = await service.get(workspaceId, projectId, appId);
      expect(policy).toMatchObject({ minSupportedVersion: '2.1.0', revision: 2 });
      const [latest] = await service.listChanges(workspaceId, projectId, appId);
      expect(latest).toMatchObject({ approvalRequestId: requestId, actorUserId: requester, reason: 'crash in 2.0.x' });
    });

    it('applies a relaxing change at once and opens a post-hoc review', async () => {
      const result = await service.change(workspaceId, projectId, appId, requester, {
        rules: rules({ approvalPolicy: gate, minSupportedVersion: '1.9.0' }),
        storeLiveAttested: false,
      });
      expect(result.outcome).toBe(VersionPolicyOutcomes.applied);
      expect(result.policy).toMatchObject({ minSupportedVersion: '1.9.0', revision: 2 });

      const { request } = await approvals.get(workspaceId, result.requestId ?? '');
      expect(request).toMatchObject({ kind: ApprovalKinds.review, state: ApprovalStates.pending });
    });

    it('applies a copy-only edit without any request', async () => {
      const result = await service.change(workspaceId, projectId, appId, requester, {
        rules: rules({ approvalPolicy: gate, softPromptIntervalHours: 24 }),
        storeLiveAttested: false,
      });
      expect(result).toMatchObject({ outcome: VersionPolicyOutcomes.applied, requestId: null });
    });

    it('gates weakening the approval policy itself', async () => {
      const result = await service.change(workspaceId, projectId, appId, requester, {
        rules: rules({ approvalPolicy: null }),
        storeLiveAttested: false,
      });
      expect(result.outcome).toBe(VersionPolicyOutcomes.pendingApproval);
    });

    it('does not apply a stale approval after the policy moved, and audits it', async () => {
      const gated = await service.change(workspaceId, projectId, appId, requester, {
        rules: rules({ approvalPolicy: gate, minSupportedVersion: '2.1.0' }),
        storeLiveAttested: true,
      });
      // A relaxing edit lands first and moves the revision.
      await service.change(workspaceId, projectId, appId, requester, {
        rules: rules({ approvalPolicy: gate, recommendedVersion: '2.3.0' }),
        storeLiveAttested: false,
      });
      await approvals.vote(workspaceId, gated.requestId ?? '', approver, 'approve');

      const policy = await service.get(workspaceId, projectId, appId);
      expect(policy).toMatchObject({ minSupportedVersion: '2.0.0', recommendedVersion: '2.3.0', revision: 2 });
      const entries = await audit.list(workspaceId, 0n);
      expect(entries.map(entry => entry.action)).toContain(AuditActions.versionPolicyApprovalStale);
      expect(await audit.verify(workspaceId)).toMatchObject({ intact: true });
    });

    it('a newer tightening change supersedes the pending one', async () => {
      const first = await service.change(workspaceId, projectId, appId, requester, {
        rules: rules({ approvalPolicy: gate, minSupportedVersion: '2.1.0' }),
        storeLiveAttested: true,
      });
      await service.change(workspaceId, projectId, appId, requester, {
        rules: rules({ approvalPolicy: gate, minSupportedVersion: '2.2.0' }),
        storeLiveAttested: true,
      });
      const { request } = await approvals.get(workspaceId, first.requestId ?? '');
      expect(request.state).toBe(ApprovalStates.superseded);
    });
  });
});
