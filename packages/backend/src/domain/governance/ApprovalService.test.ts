import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ApprovalKinds, ApprovalStates } from '@mocco/common/governance';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import {
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  ApprovalReasonRequiredError,
  DuplicateApprovalVoteError,
  NotAuthorizedToApproveError,
  SelfApprovalError,
} from '@backend/domain/governance/errors';
import { createApprovalService } from '@backend/domain/governance/instance';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { ApprovalRequestRow, ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { ApprovalKind, GateRequirements } from '@mocco/common/governance';

const SUBJECT = 'test.change';

const requirementsWith = (overrides: Partial<GateRequirements> = {}): GateRequirements => ({
  resume: [{ role: 'release', count: 2 }],
  prevent_self: true,
  reason_required: false,
  ...overrides,
});

describe('ApprovalService (pglite)', () => {
  let t: TestDb;
  let audit: AuditService;
  let service: ApprovalService;
  let applied: ApprovalRequestRow[];
  let workspaceId: string;

  async function seedWorkspace(): Promise<string> {
    return expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
  }

  async function seedUser(...roleNames: string[]): Promise<string> {
    const [user] = await t.db
      .insert(users)
      .values({ email: `${randomUUID()}@example.com`, name: 'U' })
      .returning();
    const userId = expectOne(user === undefined ? [] : [user]).id;
    const roles = new RoleRepo(t.db);
    const memberships = new RoleMembershipRepo(t.db);
    const existing = await roles.listByWorkspace(workspaceId);
    await Promise.all(
      roleNames.map(async name => {
        const role = existing.find(candidate => candidate.name === name) ?? (await roles.create({ workspaceId, name }));
        await memberships.add({ workspaceId, roleId: role.id, userId });
      }),
    );
    return userId;
  }

  async function open(
    requestedByUserId: string | null,
    overrides: Partial<GateRequirements> = {},
    kind: ApprovalKind = ApprovalKinds.preApproval,
  ) {
    return await service.request(workspaceId, {
      kind,
      subjectType: SUBJECT,
      subjectId: 'app-1',
      action: { minSupportedVersion: '3.0.0' },
      requirements: requirementsWith(overrides),
      requestedByUserId,
    });
  }

  async function stateOf(requestId: string) {
    const { request } = await service.get(workspaceId, requestId);
    return request.state;
  }

  async function voteState(requestId: string, userId: string, decision: 'approve' | 'reject', reason?: string) {
    const { request } = await service.vote(workspaceId, requestId, userId, decision, reason);
    return request.state;
  }

  beforeEach(async () => {
    t = await createTestDb();
    audit = new AuditService({ audit: new AuditRepo(t.db) });
    applied = [];
    service = createApprovalService(
      t.db,
      audit,
      new Map([
        [
          SUBJECT,
          async (request: ApprovalRequestRow) => {
            applied.push(request);
            await Promise.resolve();
          },
        ],
      ]),
    );
    workspaceId = await seedWorkspace();
  });
  afterEach(async () => {
    await t.close();
  });

  it('approves on N distinct approvers and runs the handler exactly once', async () => {
    const requester = await seedUser('release');
    const a = await seedUser('release');
    const b = await seedUser('release');
    const c = await seedUser('release');
    const request = await open(requester);

    expect(await voteState(request.id, a, 'approve')).toBe(ApprovalStates.pending);
    expect(applied).toHaveLength(0);
    expect(await voteState(request.id, b, 'approve')).toBe(ApprovalStates.approved);
    expect(applied.map(row => row.id)).toEqual([request.id]);
    await expect(service.vote(workspaceId, request.id, c, 'approve')).rejects.toBeInstanceOf(ApprovalNotPendingError);
    expect(applied).toHaveLength(1);
  });

  it('counts a voter holding two required roles once (distinct principals)', async () => {
    const requester = await seedUser('release');
    const both = await seedUser('release', 'security');
    const other = await seedUser('security');
    const request = await open(requester, {
      resume: [
        { role: 'release', count: 1 },
        { role: 'security', count: 1 },
      ],
    });

    expect(await voteState(request.id, both, 'approve')).toBe(ApprovalStates.pending);
    expect(await voteState(request.id, other, 'approve')).toBe(ApprovalStates.approved);
  });

  it('a reject resolves the request rejected and never applies it', async () => {
    const request = await open(await seedUser('release'));
    expect(await voteState(request.id, await seedUser('release'), 'reject')).toBe(ApprovalStates.rejected);
    expect(applied).toHaveLength(0);
  });

  it('a review request resolves without running the handler', async () => {
    const request = await open(
      await seedUser('release'),
      { resume: [{ role: 'release', count: 1 }] },
      ApprovalKinds.review,
    );
    expect(await voteState(request.id, await seedUser('release'), 'approve')).toBe(ApprovalStates.approved);
    expect(applied).toHaveLength(0);
  });

  it('applies the voter guards: prevent_self, role membership, reason_required, one vote per person', async () => {
    const requester = await seedUser('release');
    const request = await open(requester, { reason_required: true });
    const approver = await seedUser('release');
    const viewer = await seedUser('viewer');

    await expect(service.vote(workspaceId, request.id, requester, 'approve', 'mine')).rejects.toBeInstanceOf(
      SelfApprovalError,
    );
    await expect(service.vote(workspaceId, request.id, viewer, 'approve', 'x')).rejects.toBeInstanceOf(
      NotAuthorizedToApproveError,
    );
    await expect(service.vote(workspaceId, request.id, approver, 'approve')).rejects.toBeInstanceOf(
      ApprovalReasonRequiredError,
    );
    await service.vote(workspaceId, request.id, approver, 'approve', 'checked the store listing');
    await expect(service.vote(workspaceId, request.id, approver, 'approve', 'again')).rejects.toBeInstanceOf(
      DuplicateApprovalVoteError,
    );
  });

  it('pins the requirements at creation', async () => {
    const request = await open(await seedUser('release'));
    const { request: loaded } = await service.get(workspaceId, request.id);
    expect(loaded.requirements).toEqual(requirementsWith());
  });

  it('expires a request on a late vote and through expireDue', async () => {
    const requester = await seedUser('release');
    const approver = await seedUser('release');
    const past = new Date(Date.now() - 60_000);
    const late = await service.request(workspaceId, {
      kind: ApprovalKinds.preApproval,
      subjectType: SUBJECT,
      subjectId: 'a',
      action: {},
      requirements: requirementsWith(),
      requestedByUserId: requester,
      expiresAt: past,
    });
    await expect(service.vote(workspaceId, late.id, approver, 'approve')).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
    expect(await stateOf(late.id)).toBe(ApprovalStates.expired);

    await service.request(workspaceId, {
      kind: ApprovalKinds.preApproval,
      subjectType: SUBJECT,
      subjectId: 'b',
      action: {},
      requirements: requirementsWith(),
      requestedByUserId: requester,
      expiresAt: past,
    });
    expect(await service.expireDue(workspaceId)).toBe(1);
  });

  it('supersedes pending requests for a subject', async () => {
    const requester = await seedUser('release');
    await open(requester);
    await open(requester);
    expect(await service.supersedePending(workspaceId, SUBJECT, 'app-1', requester)).toBe(2);
    expect(await service.list(workspaceId, { state: ApprovalStates.pending })).toHaveLength(0);
  });

  it('never resolves a request through another workspace', async () => {
    const request = await open(await seedUser('release'));
    const approver = await seedUser('release');
    const otherId = await seedWorkspace();
    await expect(service.get(otherId, request.id)).rejects.toBeInstanceOf(ApprovalNotFoundError);
    await expect(service.vote(otherId, request.id, approver, 'approve')).rejects.toBeInstanceOf(ApprovalNotFoundError);
  });

  it('refuses to vote on a pre-approval whose subject has no handler, and rejects a second registration', async () => {
    const request = await service.request(workspaceId, {
      kind: ApprovalKinds.preApproval,
      subjectType: 'nobody.handles.this',
      subjectId: 'x',
      action: {},
      requirements: requirementsWith({ resume: [{ role: 'release', count: 1 }] }),
      requestedByUserId: null,
    });
    const approver = await seedUser('release');
    await expect(service.vote(workspaceId, request.id, approver, 'approve')).rejects.toThrow(/No approval handler/);
    expect(await stateOf(request.id)).toBe(ApprovalStates.pending);

    expect(() => {
      service.registerHandler(SUBJECT, async () => {
        await Promise.resolve();
      });
    }).toThrow(/already registered/);
  });

  it('records the request and its outcome in an intact audit chain', async () => {
    const request = await open(await seedUser('release'), { resume: [{ role: 'release', count: 1 }] });
    await service.vote(workspaceId, request.id, await seedUser('release'), 'approve');

    const entries = await audit.list(workspaceId, 0n);
    expect(entries.map(entry => entry.action)).toEqual([AuditActions.approvalRequested, AuditActions.approvalApproved]);
    expect(await audit.verify(workspaceId)).toMatchObject({ intact: true });
  });
});
