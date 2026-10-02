import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { OtaEventTypes } from '@mocco/common/events';
import { ApprovalDecisions, ApprovalStates } from '@mocco/common/governance';
import { OtaReleaseStatuses } from '@mocco/common/ota-hosting';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, otaChannelHeads, otaDeployments, otaReleases, users } from '@backend/infra/db/schema';
import { API, assetOf, createOtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';

import type { PublishInput } from '@backend/domain/events/EventBus';
import type { OtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';
import type { OtaChannelDto } from '@mocco/common/ota-hosting';

const POLICY = { resume: [{ role: 'mobile-release', count: 1 }], prevent_self: true, reason_required: false };

describe('gated promotion to protected channels', () => {
  let f: OtaFixture;
  let published: PublishInput[];
  let production: OtaChannelDto;
  let benId: string;

  /** A ready release (a distinct bundle each time, so each is newer). */
  const readyRelease = async (label: string) => {
    const launch = assetOf(`console.log("${label}")`, 'application/javascript', 'bundle');
    const { releaseId } = await f.publish(f.manifestOf({ launch }), launch);
    await f.ota.otaUploads.verifyAssets(releaseId);
    return releaseId;
  };

  const heads = async () => await f.t.db.select().from(otaChannelHeads);

  beforeEach(async () => {
    published = [];
    f = await createOtaFixture({
      events: {
        publish: async input => {
          published.push(input);
          return await Promise.resolve({ event: { id: randomUUID() }, created: true } as never);
        },
      },
    });
    benId = expectOne(
      await f.t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ben', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    const role = await new RoleRepo(f.t.db).create({ workspaceId: f.workspaceId, name: 'mobile-release' });
    const memberships = new RoleMembershipRepo(f.t.db);
    await memberships.add({ workspaceId: f.workspaceId, roleId: role.id, userId: f.ownerId });
    await memberships.add({ workspaceId: f.workspaceId, roleId: role.id, userId: benId });
    production = await f.ota.otaHosting.createChannel(f.appRow, f.ownerId, { name: 'production', policy: POLICY });
  });
  afterEach(async () => {
    await f.close();
  });

  it('writes no protected head from any surface without an approved request', async () => {
    const releaseId = await readyRelease('v1');

    const fromConsole = await f.ota.otaChannels.promote(f.appRow, production.id, releaseId, f.ownerId, null);
    const fromKey = await f.call(
      'POST',
      `${API}/ota/apps/${f.otaAppId}/releases/${releaseId}/promotions`,
      f.secretToken,
      {
        channel: 'production',
      },
    );

    expect(fromConsole).toMatchObject({ outcome: 'pending_approval', changed: false });
    expect(fromKey.status).toBe(202);
    expect(await heads()).toEqual([]);
    // The newer request superseded the console one: one pending change per channel.
    const pending = await f.approvals.list(f.workspaceId, { state: ApprovalStates.pending });
    expect(pending).toHaveLength(1);
    expect(published.map(event => event.type)).toEqual([
      OtaEventTypes.otaPromotionRequested,
      OtaEventTypes.otaPromotionRequested,
    ]);
  });

  it('applies the pinned promotion once approved, and records the approvers and their roles', async () => {
    const releaseId = await readyRelease('v1');
    const { requestId } = await f.ota.otaChannels.promote(f.appRow, production.id, releaseId, f.ownerId, 'ship it');

    await f.approvals.vote(f.workspaceId, requestId ?? '', benId, ApprovalDecisions.approve);

    expect(await heads()).toHaveLength(1);
    const [deployment] = await f.t.db.select().from(otaDeployments);
    expect(deployment).toMatchObject({ approvalRequestId: requestId, releaseId, reason: 'ship it' });
    const audit = await f.t.db.select().from(auditLog);
    const changed = audit.find(entry => entry.action === AuditActions.otaChannelChanged);
    expect(changed?.payload).toMatchObject({
      approvalRequestId: requestId,
      approvers: [{ userId: benId, roleId: expect.any(String) }],
    });
    expect(published.map(event => event.type)).toContain(OtaEventTypes.otaPromotionApproved);
  });

  it("refuses the requester's own approval, also when CI acts for them through their key", async () => {
    const releaseId = await readyRelease('v1');
    const fromKey = await f.call(
      'POST',
      `${API}/ota/apps/${f.otaAppId}/releases/${releaseId}/promotions`,
      f.secretToken,
      {
        channel: 'production',
      },
    );
    const { requestId } = (await fromKey.json()) as { requestId: string };

    // Ada created the CI key, so the request is hers.
    await expect(f.approvals.vote(f.workspaceId, requestId, f.ownerId, ApprovalDecisions.approve)).rejects.toThrow(
      /approve a change you requested/u,
    );
    expect(await heads()).toEqual([]);
  });

  it('supersedes pending promotions when the channel policy changes', async () => {
    const releaseId = await readyRelease('v1');
    const { requestId } = await f.ota.otaChannels.promote(f.appRow, production.id, releaseId, f.ownerId, null);

    const change = await f.ota.otaHosting.changeChannelPolicy(f.appRow, f.ownerId, production.id, {
      ...POLICY,
      resume: [{ role: 'mobile-release', count: 2 }],
    });
    await f.approvals.vote(f.workspaceId, change.requestId ?? '', benId, ApprovalDecisions.approve);

    const { request } = await f.approvals.get(f.workspaceId, requestId ?? '');
    expect(request.state).toBe(ApprovalStates.superseded);
    expect(await heads()).toEqual([]);
  });

  it('notifies a rejection and changes nothing', async () => {
    const releaseId = await readyRelease('v1');
    const { requestId } = await f.ota.otaChannels.promote(f.appRow, production.id, releaseId, f.ownerId, null);

    await f.approvals.vote(f.workspaceId, requestId ?? '', benId, ApprovalDecisions.reject);

    expect(await heads()).toEqual([]);
    expect(published.map(event => event.type)).toEqual([
      OtaEventTypes.otaPromotionRequested,
      OtaEventTypes.otaPromotionRejected,
    ]);
    const [requested] = published;
    expect(requested?.payload).toMatchObject({
      facts: { channel: 'production', release: releaseId },
      message: { title: expect.stringMatching(/^Approval needed: Promote Fix the login button → production$/u) },
    });
  });

  it("doesn't apply an approval that went stale, and audits why", async () => {
    const releaseId = await readyRelease('v1');
    const { requestId } = await f.ota.otaChannels.promote(f.appRow, production.id, releaseId, f.ownerId, null);
    // The release is disabled while the request waits.
    await f.t.db.update(otaReleases).set({ status: OtaReleaseStatuses.disabled }).where(eq(otaReleases.id, releaseId));

    await f.approvals.vote(f.workspaceId, requestId ?? '', benId, ApprovalDecisions.approve);

    expect(await heads()).toEqual([]);
    const audit = await f.t.db.select().from(auditLog);
    const failed = audit.find(entry => entry.action === AuditActions.otaChannelChangeFailed);
    expect(failed?.payload).toMatchObject({
      approvalRequestId: requestId,
      reason: expect.stringMatching(/is disabled/u),
    });
  });
});
