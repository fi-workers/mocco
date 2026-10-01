import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ApprovalDecisions } from '@mocco/common/governance';
import { FULL_ROLLOUT_BP, OtaDeploymentKinds, StopActions } from '@mocco/common/ota-hosting';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { rolloutBucket } from '@backend/domain/ota/serving/select';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, otaChannelHeads, otaDeployments, users } from '@backend/infra/db/schema';
import { API, createOtaFixture, RUNTIME } from '@backend/transport/ext/v1/testing/ota-fixture';

import type { OtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';
import type { OtaChannelDto } from '@mocco/common/ota-hosting';

interface Served {
  status: number;
  id: string | null;
  createdAt: string | null;
  part: string | null;
}

describe('staged rollout, pause and instant rollback', () => {
  let f: OtaFixture;
  let staging: OtaChannelDto;

  /** What a device on `currentUpdateId` gets from the channel. */
  const check = async (clientId: string, currentUpdateId?: string, channel = 'staging'): Promise<Served> => {
    const response = await f.app.fetch(
      new Request(`${API}/ota/apps/${f.otaAppId}/manifest`, {
        headers: {
          'expo-protocol-version': '1',
          'expo-platform': 'ios',
          'expo-runtime-version': RUNTIME,
          'expo-channel-name': channel,
          'eas-client-id': clientId,
          ...(currentUpdateId !== undefined && { 'expo-current-update-id': currentUpdateId }),
        },
      }),
    );
    if (response.status !== 200) {
      return { status: response.status, id: null, createdAt: null, part: null };
    }
    const body = await response.text();
    const part = /name="(?<part>manifest|directive)"/u.exec(body)?.groups?.part ?? null;
    const json = /\r\n\r\n(?<json>\{.*?\})\r\n--/su.exec(body)?.groups?.json ?? '{}';
    const parsed = JSON.parse(json) as { id?: string; createdAt?: string };
    return { status: 200, id: parsed.id ?? null, createdAt: parsed.createdAt ?? null, part };
  };

  const devices = Array.from({ length: 200 }, (_, index) => `device-${index}`);
  const salt = async () => expectOne(await f.t.db.select().from(otaChannelHeads)).rolloutSalt;
  const stop = async (action: (typeof StopActions)[keyof typeof StopActions]) =>
    await f.ota.otaChannels.stopFromConsole(f.appRow, staging.id, action, f.ownerId, {
      runtimeVersion: null,
      reason: null,
    });

  beforeEach(async () => {
    f = await createOtaFixture();
    staging = await f.ota.otaHosting.createChannel(f.appRow, f.ownerId, { name: 'staging', policy: null });
  });
  afterEach(async () => {
    await f.close();
  });

  it('rolls a candidate out to its share of devices, adds devices as the share grows, and completes', async () => {
    const v1 = await f.publishReady('v1');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v1.releaseId, f.ownerId, null);
    const v2 = await f.publishReady('v2');

    await f.ota.otaChannels.promote(f.appRow, staging.id, v2.releaseId, f.ownerId, null, 2500);
    const headSalt = await salt();
    const inQuarter = devices.filter(id => rolloutBucket(headSalt, id) < 2500);
    const served = await Promise.all(devices.map(async id => await check(id)));
    expect(served.filter(item => item.id === v2.updateId)).toHaveLength(inQuarter.length);
    expect(served.filter(item => item.id === v1.updateId)).toHaveLength(devices.length - inQuarter.length);

    await f.ota.otaChannels.changeRollout(
      f.appRow,
      staging.id,
      { kind: 'rollout', rolloutBp: 5000, runtimeVersion: null },
      f.ownerId,
      null,
    );
    const half = await Promise.all(devices.map(async id => await check(id)));
    const onV2 = new Set(devices.filter((_, index) => half[index]?.id === v2.updateId));
    expect(inQuarter.every(id => onV2.has(id))).toBe(true);
    expect(onV2.size).toBeGreaterThan(inQuarter.length);

    await f.ota.otaChannels.changeRollout(
      f.appRow,
      staging.id,
      { kind: 'complete', runtimeVersion: null },
      f.ownerId,
      null,
    );
    const done = await Promise.all(devices.map(async id => await check(id)));
    expect(done.every(item => item.id === v2.updateId)).toBe(true);
  });

  it('pauses new adoption, but devices already on the candidate keep it', async () => {
    const v1 = await f.publishReady('v1');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v1.releaseId, f.ownerId, null);
    const v2 = await f.publishReady('v2');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v2.releaseId, f.ownerId, null, 5000);
    const headSalt = await salt();
    const inside = devices.find(id => rolloutBucket(headSalt, id) < 5000) ?? '';

    await stop(StopActions.pause);

    // Not yet updated: gets the active update. Already on the candidate: nothing new.
    expect(await check(inside, v1.updateId)).toMatchObject({ status: 204 });
    expect(await check(inside)).toMatchObject({ id: v1.updateId });
    expect(await check(inside, v2.updateId)).toMatchObject({ status: 204 });
    await f.ota.otaChannels.changeRollout(
      f.appRow,
      staging.id,
      { kind: 'resume', runtimeVersion: null },
      f.ownerId,
      null,
    );
    expect(await check(inside, v1.updateId)).toMatchObject({ id: v2.updateId });
  });

  it('rolls back instantly to the pre-signed republish, which devices on the bad release take', async () => {
    const v1 = await f.publishReady('v1');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v1.releaseId, f.ownerId, null);
    const v2 = await f.publishReady('v2');
    expect(v2.rollbackTargets).toBe(1);
    await f.ota.otaChannels.promote(f.appRow, staging.id, v2.releaseId, f.ownerId, null);
    const bad = await check('device-1');

    const result = await stop(StopActions.rollback);

    expect(result).toMatchObject({ kind: OtaDeploymentKinds.rollback, releaseId: v2.releaseId, changed: true });
    const back = await check('device-1', v2.updateId);
    expect(back.id).not.toBe(v2.updateId);
    expect(back.id).not.toBe(v1.updateId);
    expect(new Date(back.createdAt ?? 0).getTime()).toBeGreaterThan(new Date(bad.createdAt ?? 0).getTime());
  });

  it('aborts a rollout as a rollback: devices on the candidate get the active content, re-dated', async () => {
    const v1 = await f.publishReady('v1');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v1.releaseId, f.ownerId, null);
    const v2 = await f.publishReady('v2');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v2.releaseId, f.ownerId, null, 5000);

    await stop(StopActions.rollback);

    const onCandidate = await check('device-7', v2.updateId);
    expect(onCandidate.status).toBe(200);
    expect(onCandidate.id).not.toBe(v2.updateId);
    const [head] = await f.t.db.select().from(otaChannelHeads);
    expect(head).toMatchObject({ candidateUpdateId: null, rolloutBp: 0, previousUpdateId: v2.updateId });
  });

  it('rolls back to the embedded bundle with the pre-signed directive', async () => {
    const v1 = await f.publishReady('v1');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v1.releaseId, f.ownerId, null);

    await stop(StopActions.rollbackEmbedded);

    expect(await check('device-1', v1.updateId)).toMatchObject({ status: 200, part: 'directive' });
    // A first release has no earlier republish to return to.
    await expect(stop(StopActions.rollback)).rejects.toThrow(/no pre-signed rollback on ios/u);
  });

  it('gates rollout changes on a protected channel, never the stop actions, and records every change', async () => {
    const benId = expectOne(
      await f.t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ben', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    const role = await new RoleRepo(f.t.db).create({ workspaceId: f.workspaceId, name: 'mobile-release' });
    await new RoleMembershipRepo(f.t.db).add({ workspaceId: f.workspaceId, roleId: role.id, userId: benId });
    const production = await f.ota.otaHosting.createChannel(f.appRow, f.ownerId, {
      name: 'production',
      policy: { resume: [{ role: 'mobile-release', count: 1 }], prevent_self: true, reason_required: false },
    });
    const v1 = await f.publishReady('v1');
    const first = await f.ota.otaChannels.promote(f.appRow, production.id, v1.releaseId, f.ownerId, null);
    await f.approvals.vote(f.workspaceId, first.requestId ?? '', benId, ApprovalDecisions.approve);
    const v2 = await f.publishReady('v2');

    const rollout = await f.ota.otaChannels.promote(f.appRow, production.id, v2.releaseId, f.ownerId, null, 1000);
    expect(rollout).toMatchObject({ outcome: 'pending_approval', kind: OtaDeploymentKinds.rollout });
    await f.approvals.vote(f.workspaceId, rollout.requestId ?? '', benId, ApprovalDecisions.approve);
    const paused = await f.ota.otaChannels.stopFromConsole(f.appRow, production.id, StopActions.pause, f.ownerId, {
      runtimeVersion: null,
      reason: 'crash spike',
    });
    expect(paused).toMatchObject({ outcome: 'applied', changed: true });
    const rolledBack = await f.ota.otaChannels.stopFromConsole(
      f.appRow,
      production.id,
      StopActions.rollback,
      f.ownerId,
      { runtimeVersion: null, reason: 'crash spike' },
    );
    expect(rolledBack.outcome).toBe('applied');

    const deployments = await f.t.db.select().from(otaDeployments);
    expect(deployments.map(row => row.kind)).toHaveLength(4);
    expect(deployments.map(row => row.kind)).toEqual(
      expect.arrayContaining([
        OtaDeploymentKinds.pause,
        OtaDeploymentKinds.promote,
        OtaDeploymentKinds.rollback,
        OtaDeploymentKinds.rollout,
      ]),
    );
    expect(deployments.find(row => row.kind === OtaDeploymentKinds.rollout)).toMatchObject({ toBp: 1000 });
    const audit = await f.t.db.select().from(auditLog);
    expect(audit.filter(entry => entry.action === AuditActions.otaChannelChanged)).toHaveLength(4);
    expect(FULL_ROLLOUT_BP).toBe(10_000);
  });
});
