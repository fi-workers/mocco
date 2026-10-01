import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { OtaPlatforms, OtaReleaseStatuses } from '@mocco/common/ota-hosting';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OTHER_SIGNING_KEY_PEM, TEST_SIGNING_KEY_PEM } from '@backend/domain/ota/testing/signing-fixtures';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, otaChannelHeads, otaReleases, otaSignedDirectives, otaUpdates } from '@backend/infra/db/schema';
import { API, bundle, createOtaFixture, image, RUNTIME, signBody } from '@backend/transport/ext/v1/testing/ota-fixture';

import type { OtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';

describe('/v1/ota uploads (pglite + filesystem store)', () => {
  let f: OtaFixture;
  // Shorthands for the fixture's parts, so the tests read like the CLI's steps.
  let t: OtaFixture['t'];
  let app: OtaFixture['app'];
  let ota: OtaFixture['ota'];
  let workspaceId: string;
  let otaAppId: string;
  let secretToken: string;
  let enqueued: OtaFixture['enqueued'];
  let ownerId: string;
  let projectId: string;
  const call: OtaFixture['call'] = async (...args) => await f.call(...args);
  const newSession: OtaFixture['newSession'] = async () => await f.newSession();
  const declare: OtaFixture['declare'] = async (...args) => await f.declare(...args);
  const putMissing: OtaFixture['putMissing'] = async (...args) => {
    await f.putMissing(...args);
  };
  const manifestOf: OtaFixture['manifestOf'] = (...args) => f.manifestOf(...args);
  const finalize: OtaFixture['finalize'] = async (...args) => await f.finalize(...args);
  const publish: OtaFixture['publish'] = async (...args) => await f.publish(...args);

  beforeEach(async () => {
    f = await createOtaFixture();
    ({ t, app, ota, workspaceId, otaAppId, secretToken, enqueued, ownerId, projectId } = f);
  });
  afterEach(async () => {
    await f.close();
  });

  it('uploads, verifies and readies a signed release, and audits it with the git SHA and principal', async () => {
    const { releaseId, declared } = await publish();

    expect(declared.assetBaseUrl).toBe(`${API}/ota/apps/${otaAppId}/assets`);
    expect(declared.missing.map(target => target.hash)).toHaveLength(2);
    expect(declared.missing.map(target => target.hash)).toEqual(expect.arrayContaining([bundle.hash, image.hash]));
    expect(enqueued).toEqual([{ kind: 'ota.verifyAssets', payload: { releaseId } }]);
    const [release] = await t.db.select().from(otaReleases);
    expect(release?.status).toBe(OtaReleaseStatuses.verifying);

    expect(await ota.otaUploads.verifyAssets(releaseId)).toBe(OtaReleaseStatuses.ready);

    const [update] = await t.db.select().from(otaUpdates);
    expect(update?.totalBytes).toBe(Buffer.byteLength(bundle.bytes) + Buffer.byteLength(image.bytes));
    const audit = await t.db.select().from(auditLog);
    const uploaded = audit.find(entry => entry.action === AuditActions.otaReleaseUploaded);
    expect(uploaded?.payload).toMatchObject({ gitSha: 'abc1234', principal: expect.stringMatching(/^apikey:/u) });
  });

  it('asks for zero bytes when every asset is already stored', async () => {
    const first = await publish();
    await ota.otaUploads.verifyAssets(first.releaseId);

    const session = await newSession();
    const declared = await declare(session, [bundle, image]);

    expect(declared.missing).toEqual([]);
  });

  it('rejects a far-future createdAt, a foreign asset URL and a bad signature, and stores nothing', async () => {
    const session = await newSession();
    const declared = await declare(session, [bundle, image]);
    await putMissing(declared, [bundle, image]);
    const attempt = async (manifest: string, keyPem = TEST_SIGNING_KEY_PEM) => {
      const response = await finalize(session, declared.releaseId, {
        updates: [{ platform: OtaPlatforms.ios, body: manifest, signature: signBody(manifest, keyPem) }],
      });
      expect(response.status).toBe(400);
      return ((await response.json()) as { detail: string }).detail;
    };

    expect(await attempt(manifestOf({ createdAt: new Date(Date.now() + 60 * 60 * 1000) }))).toMatch(
      /more than 10 minutes ahead/u,
    );
    expect(await attempt(manifestOf({ assetUrlBase: 'https://evil.test/assets' }))).toMatch(
      /asset URLs must be https:\/\/mocco\.test/u,
    );
    expect(await attempt(manifestOf(), OTHER_SIGNING_KEY_PEM)).toMatch(/signature doesn't verify/u);
    const unsigned = await finalize(session, declared.releaseId, {
      updates: [{ platform: OtaPlatforms.ios, body: manifestOf() }],
    });
    expect(((await unsigned.json()) as { detail: string }).detail).toMatch(/requires signed updates/u);
    expect(await t.db.select().from(otaUpdates)).toEqual([]);

    // Fixed, the same release finalizes.
    const manifest = manifestOf();
    const fixed = await finalize(session, declared.releaseId, {
      updates: [{ platform: OtaPlatforms.ios, body: manifest, signature: signBody(manifest) }],
    });
    expect(fixed.status).toBe(200);
    const again = await finalize(session, declared.releaseId, {
      updates: [{ platform: OtaPlatforms.ios, body: manifest, signature: signBody(manifest) }],
    });
    expect(again.status).toBe(409);
  });

  it('fails a release whose stored bytes no longer match, and asks for them again', async () => {
    const { releaseId, declared } = await publish();
    // Overwrite the bundle's bytes in place, behind Mocco's back.
    const target = declared.missing.find(candidate => candidate.hash === bundle.hash);
    await app.fetch(
      new Request(target?.putUrl ?? '', { method: 'PUT', headers: target?.headers, body: 'tampered!!!!!!!!!' }),
    );

    expect(await ota.otaUploads.verifyAssets(releaseId)).toBe(OtaReleaseStatuses.failed);

    const audit = await t.db.select().from(auditLog);
    const actions = audit.map(entry => entry.action);
    expect(actions).toContain(AuditActions.otaReleaseFailed);
    const next = await declare(await newSession(), [bundle, image]);
    expect(next.missing.map(missing => missing.hash)).toEqual([bundle.hash]);
  });

  it('accepts a pre-signed republish of the channel head and a rollBackToEmbedded directive', async () => {
    const first = await publish();
    await ota.otaUploads.verifyAssets(first.releaseId);
    const headUpdate = expectOne(await t.db.select().from(otaUpdates));
    const appRow = await ota.otaHosting.requireApp(workspaceId, projectId, otaAppId);
    const channel = await ota.otaHosting.createChannel(appRow, ownerId, { name: 'production', policy: null });
    await t.db.insert(otaChannelHeads).values({
      workspaceId,
      channelId: channel.id,
      platform: OtaPlatforms.ios,
      runtimeVersion: RUNTIME,
      activeUpdateId: headUpdate.id,
      rolloutSalt: 'salt',
    });

    const session = await newSession();
    const declared = await declare(session, [bundle, image]);
    expect(declared.missing).toEqual([]);
    expect(declared.rollbackTargets).toEqual([
      { channel: 'production', platform: OtaPlatforms.ios, updateId: headUpdate.id, manifest: headUpdate.manifestBody },
    ]);
    const createdAt = new Date();
    const manifest = manifestOf({ createdAt });
    const later = new Date(createdAt.getTime() + 1).toISOString();
    const [target] = declared.rollbackTargets;
    const republishOf = (at: string) =>
      JSON.stringify({ ...(JSON.parse(target?.manifest ?? '{}') as object), id: randomUUID(), createdAt: at });
    const directive = JSON.stringify({ type: 'rollBackToEmbedded', parameters: { commitTime: later } });
    const body = (republish: string) => ({
      updates: [{ platform: OtaPlatforms.ios, body: manifest, signature: signBody(manifest) }],
      republishes: [
        { platform: OtaPlatforms.ios, targetUpdateId: headUpdate.id, body: republish, signature: signBody(republish) },
      ],
      directives: [{ platform: OtaPlatforms.ios, body: directive, signature: signBody(directive) }],
    });

    const stale = await finalize(session, declared.releaseId, body(republishOf(createdAt.toISOString())));
    expect(((await stale.json()) as { detail: string }).detail).toMatch(/must be later than the release's update/u);
    const response = await finalize(session, declared.releaseId, body(republishOf(later)));

    expect(response.status).toBe(200);
    const { updates } = (await response.json()) as { updates: Record<string, string> };
    const rows = await t.db.select().from(otaUpdates);
    const republish = rows.find(row => row.kind === 'republish');
    expect(republish).toMatchObject({ contentOfUpdateId: headUpdate.id, supersedesUpdateId: updates.ios });
    const directives = await t.db.select().from(otaSignedDirectives);
    expect(directives).toMatchObject([{ type: 'rollBackToEmbedded', supersedesUpdateId: updates.ios }]);
  });

  it('pre-signs one republish per distinct channel head, also when channels share or differ', async () => {
    const first = await publish(manifestOf());
    await ota.otaUploads.verifyAssets(first.releaseId);
    const second = await publish(manifestOf());
    await ota.otaUploads.verifyAssets(second.releaseId);
    const [one, two] = await t.db.select().from(otaUpdates);
    const appRow = await ota.otaHosting.requireApp(workspaceId, projectId, otaAppId);
    const channels = await Promise.all(
      ['staging', 'beta', 'production'].map(
        async name => await ota.otaHosting.createChannel(appRow, ownerId, { name, policy: null }),
      ),
    );
    // staging and beta serve the same update; production serves another.
    await t.db.insert(otaChannelHeads).values(
      channels.map((channel, index) => ({
        workspaceId,
        channelId: channel.id,
        platform: OtaPlatforms.ios,
        runtimeVersion: RUNTIME,
        activeUpdateId: index < 2 ? (one?.id ?? '') : (two?.id ?? ''),
        rolloutSalt: 'salt',
      })),
    );

    const session = await newSession();
    const declared = await declare(session, [bundle, image]);
    expect(declared.rollbackTargets.map(target => target.channel)).toHaveLength(2);
    expect(declared.rollbackTargets.map(target => target.channel)).toEqual(
      expect.arrayContaining(['production', 'staging, beta']),
    );
    const createdAt = new Date();
    const manifest = manifestOf({ createdAt });
    const later = new Date(createdAt.getTime() + 1).toISOString();
    const response = await finalize(session, declared.releaseId, {
      updates: [{ platform: OtaPlatforms.ios, body: manifest, signature: signBody(manifest) }],
      republishes: declared.rollbackTargets.map(target => {
        const body = JSON.stringify({ ...(JSON.parse(target.manifest) as object), id: randomUUID(), createdAt: later });
        return { platform: OtaPlatforms.ios, targetUpdateId: target.updateId, body, signature: signBody(body) };
      }),
    });

    expect(response.status).toBe(200);
  });

  it('fails releases abandoned before finalize once their session has expired', async () => {
    const session = await newSession();
    const declared = await declare(session, [bundle]);
    await t.db
      .update(otaReleases)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(otaReleases.id, declared.releaseId));

    expect(await ota.otaUploads.pruneSessions()).toEqual({ sessions: 0, abandoned: 1 });
    const [release] = await t.db.select().from(otaReleases);
    expect(release?.status).toBe(OtaReleaseStatuses.failed);
  });

  it('refuses unknown sessions, apps of other projects and a second release per session', async () => {
    const unknown = await call('POST', `${API}/ota/uploads`, 'mk_ups_nope', {});
    expect(unknown.status).toBe(401);
    const foreign = await call('POST', `${API}/ota/apps/${randomUUID()}/upload-sessions`, secretToken);
    expect(foreign.status).toBe(404);

    const session = await newSession();
    await declare(session, [bundle]);
    const second = await call('POST', `${API}/ota/uploads`, session, {
      runtimeVersion: RUNTIME,
      platforms: [OtaPlatforms.ios],
      assets: [{ hash: bundle.hash, size: 1, contentType: bundle.contentType, ext: 'bundle' }],
    });
    expect(second.status).toBe(409);
  });
});
