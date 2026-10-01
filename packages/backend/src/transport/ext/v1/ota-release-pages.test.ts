import { OtaDeploymentKinds, StopActions, TimelineRanges } from '@mocco/common/ota-hosting';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { otaDeployments } from '@backend/infra/db/schema';
import { createOtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';

import type { OtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';
import type { OtaChannelDto } from '@mocco/common/ota-hosting';

describe('release pages: channel timeline, release detail, certificate usage', () => {
  let f: OtaFixture;
  let staging: OtaChannelDto;

  beforeEach(async () => {
    f = await createOtaFixture();
    staging = await f.ota.otaHosting.createChannel(f.appRow, f.ownerId, { name: 'staging', policy: null });
  });
  afterEach(async () => {
    await f.close();
  });

  it("lists a channel's history newest first, within the range, with release and actor", async () => {
    const v1 = await f.publishReady('v1');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v1.releaseId, f.ownerId, 'first');
    const v2 = await f.publishReady('v2');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v2.releaseId, f.ownerId, null, 2000);
    await f.ota.otaChannels.stopFromConsole(f.appRow, staging.id, StopActions.pause, f.ownerId, {
      runtimeVersion: null,
      reason: 'crash spike',
    });
    // The first promotion happened six weeks ago.
    const all = await f.ota.otaChannels.timeline(f.appRow, staging.id, TimelineRanges.all);
    await f.t.db
      .update(otaDeployments)
      .set({ createdAt: new Date(Date.now() - 42 * 24 * 60 * 60 * 1000) })
      .where(eq(otaDeployments.id, all.at(-1)?.id ?? ''));

    const month = await f.ota.otaChannels.timeline(f.appRow, staging.id, TimelineRanges.month);
    const everything = await f.ota.otaChannels.timeline(f.appRow, staging.id, TimelineRanges.all);

    expect(everything.map(entry => entry.kind)).toEqual([
      OtaDeploymentKinds.pause,
      OtaDeploymentKinds.rollout,
      OtaDeploymentKinds.promote,
    ]);
    expect(month.map(entry => entry.kind)).toEqual([OtaDeploymentKinds.pause, OtaDeploymentKinds.rollout]);
    expect(everything[1]).toMatchObject({ releaseId: v2.releaseId, toBp: 2000, actorName: 'Ada' });
    expect(everything[0]?.reason).toBe('crash spike');
  });

  it("shows a release's updates, where it's served, and which runtime versions depend on the certificate", async () => {
    const v1 = await f.publishReady('v1');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v1.releaseId, f.ownerId, null);
    const v2 = await f.publishReady('v2');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v2.releaseId, f.ownerId, null, 5000);

    const release = await f.ota.otaUploads.getRelease(f.appRow, v2.releaseId);
    const detail = await f.ota.otaChannels.releaseDetail(f.appRow, v2.releaseId, release);
    const usage = await f.ota.otaSigning.usage(f.appRow);

    // v2 has its own update and the pre-signed republish of v1 (staging's head at upload).
    expect(detail.updates.map(update => update.kind).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'original',
      'republish',
    ]);
    expect(detail.servedOn).toEqual([
      expect.objectContaining({ channel: 'staging', platform: 'ios', role: 'candidate', rolloutBp: 5000 }),
    ]);
    expect(usage).toEqual([
      {
        certificateId: expect.any(String),
        runtimes: [expect.objectContaining({ runtimeVersion: '1.0.0', updates: 3 })],
      },
    ]);
  });
});
