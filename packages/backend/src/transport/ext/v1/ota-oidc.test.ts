import { AuditActions } from '@mocco/common/audit';
import { OtaPlatforms } from '@mocco/common/ota-hosting';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashToken } from '@backend/domain/execution/callback-token';
import { createTestIssuer, jobClaims, REPOSITORY_ID } from '@backend/domain/integration/github/testing/oidc-tokens';
import { auditLog, otaUploadSessions } from '@backend/infra/db/schema';
import { API, bundle, createOtaFixture, image, ORIGIN, signBody } from '@backend/transport/ext/v1/testing/ota-fixture';

import type { OtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';

type Issuer = Awaited<ReturnType<typeof createTestIssuer>>;

describe('trusted publishing: POST /v1/ota/auth/oidc', () => {
  let f: OtaFixture;
  let issuer: Issuer;

  const exchange = async (token: string, appId = f.otaAppId) =>
    await f.app.fetch(
      new Request(`${API}/ota/auth/oidc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, token }),
      }),
    );

  /** A job token for Mocco's audience (the public API origin). */
  const jobToken = async (overrides: Parameters<typeof jobClaims>[0] = {}, audience = ORIGIN) =>
    await issuer.tokenFor(jobClaims(overrides), { audience });

  beforeEach(async () => {
    issuer = await createTestIssuer();
    f = await createOtaFixture({ oidcKeys: issuer.keys });
    await Promise.all(
      ['staging', 'beta'].map(
        async name => await f.ota.otaHosting.createChannel(f.appRow, f.ownerId, { name, policy: null }),
      ),
    );
    await f.ota.otaTrustPolicies.create(f.appRow, f.ownerId, {
      repositoryId: REPOSITORY_ID,
      repository: 'acme/mobile',
      refPattern: 'refs/heads/main',
      workflowRef: 'acme/mobile/.github/workflows/ota.yml@refs/heads/main',
      environment: null,
      allowedChannels: ['staging'],
    });
  });
  afterEach(async () => {
    await f.close();
  });

  it('mints a 15-minute session, stored as a hash, that uploads and promotes only to the allowed channels', async () => {
    const response = await exchange(await jobToken());

    expect(response.status).toBe(201);
    const { sessionToken, expiresAt, allowedChannels } = (await response.json()) as {
      sessionToken: string;
      expiresAt: string;
      allowedChannels: string[];
    };
    expect(allowedChannels).toEqual(['staging']);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
    const [session] = await f.t.db.select().from(otaUploadSessions);
    expect(session?.tokenHash).toBe(hashToken(sessionToken));
    expect(session?.principal).toBe(`github:repo:${REPOSITORY_ID}:ref:refs/heads/main`);

    const declared = await f.declare(sessionToken, [bundle, image]);
    await f.putMissing(declared, [bundle, image]);
    const manifest = f.manifestOf();
    const finalized = await f.finalize(sessionToken, declared.releaseId, {
      updates: [{ platform: OtaPlatforms.ios, body: manifest, signature: signBody(manifest) }],
    });
    expect(finalized.status).toBe(200);
    await f.ota.otaUploads.verifyAssets(declared.releaseId);
    const status = await f.call('GET', `${API}/ota/uploads/${declared.releaseId}`, sessionToken);
    expect(await status.json()).toMatchObject({ status: 'ready' });

    const promote = async (channel: string) =>
      await f.call('POST', `${API}/ota/uploads/${declared.releaseId}/promotions`, sessionToken, { channel });
    const beta = await promote('beta');
    expect(beta.status).toBe(403);
    expect(((await beta.json()) as { detail: string }).detail).toMatch(/may promote only to staging/u);
    const staging = await promote('staging');
    expect(staging.status).toBe(201);
  });

  it('denies other repositories (forks), refs, workflows and audiences with the same 403, and audits each', async () => {
    const tokens = await Promise.all([
      jobToken({ repository_id: '987654321', repository: 'evil/mobile' }),
      jobToken({ ref: 'refs/heads/feature' }),
      jobToken({ ref: 'refs/pull/12/merge' }),
      jobToken({ job_workflow_ref: 'acme/mobile/.github/workflows/other.yml@refs/heads/main' }),
      jobToken({}, 'https://evil.test'),
      Promise.resolve('not-a-jwt'),
    ]);

    const responses = await Promise.all(tokens.map(async token => await exchange(token)));

    expect(responses.map(response => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
    const bodies = await Promise.all(responses.map(async response => await response.json()));
    expect(new Set(bodies.map(body => JSON.stringify(body))).size).toBe(1);
    const audit = await f.t.db.select().from(auditLog);
    expect(audit.filter(entry => entry.action === AuditActions.otaUploadDenied)).toHaveLength(6);
    expect(await f.t.db.select().from(otaUploadSessions)).toEqual([]);
  });
});
