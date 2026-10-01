import { randomUUID, verify, X509Certificate } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { OtaReleaseStatuses } from '@mocco/common/ota-hosting';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseSignatureHeader } from '@backend/domain/ota/manifest/signature';
import { ChannelHeadRepo } from '@backend/domain/ota/repos/channel-head.repo';
import { TEST_SIGNING_CERT_PEM } from '@backend/domain/ota/testing/signing-fixtures';
import { auditLog } from '@backend/infra/db/schema';
import { API, assetOf, bundle, createOtaFixture, RUNTIME } from '@backend/transport/ext/v1/testing/ota-fixture';

import type { OtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';

interface Part {
  headers: Record<string, string>;
  body: string;
}

/** Split a multipart/mixed body the way expo-updates does: by boundary, then headers.
 * (sonarjs/null-dereference is a false positive on these strings, so it is off below.) */
/* eslint-disable sonarjs/null-dereference */
function partsOf(body: string, contentType: string): Part[] {
  const boundary = /boundary=(?<value>.+)$/u.exec(contentType)?.groups?.value ?? '';
  return body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map(chunk => {
      const [head = '', ...rest] = chunk.replace(/^\r\n/u, '').split('\r\n\r\n');
      const headers = Object.fromEntries(
        head.split('\r\n').map(line => {
          const colon = line.indexOf(':');
          return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
        }),
      );
      return { headers, body: rest.join('\r\n\r\n').replace(/\r\n$/u, '') };
    });
}
/* eslint-enable sonarjs/null-dereference */

/** What the device does: verify the manifest part's expo-signature against its embedded certificate. */
function isVerifiedOnDevice(part: Part): boolean {
  const signature = parseSignatureHeader(part.headers['expo-signature'] ?? '');
  if (signature === null) {
    return false;
  }
  const { publicKey } = new X509Certificate(TEST_SIGNING_CERT_PEM);
  // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Uint8Array.fromBase64 isn't in Node 22
  return verify('sha256', Buffer.from(part.body), publicKey, Buffer.from(signature.sig, 'base64'));
}

describe('Expo Updates manifest endpoint (golden protocol tests)', () => {
  let f: OtaFixture;
  let channelId: string;

  const manifestUrl = () => `${API}/ota/apps/${f.otaAppId}/manifest`;

  const check = async (headers: Record<string, string> = {}, url = manifestUrl()) =>
    await f.app.fetch(
      new Request(url, {
        headers: {
          'expo-protocol-version': '1',
          'expo-platform': 'ios',
          'expo-runtime-version': RUNTIME,
          'expo-channel-name': 'staging',
          accept: 'multipart/mixed,application/expo+json,application/json',
          'eas-client-id': 'device-1',
          ...headers,
        },
      }),
    );

  /** Publish, verify and promote a release to staging; returns its manifest. */
  const release = async (launch = bundle) => {
    const published = await f.publish(f.manifestOf({ launch }), launch);
    await f.ota.otaUploads.verifyAssets(published.releaseId);
    await f.ota.otaChannels.promote(f.appRow, channelId, published.releaseId, f.ownerId, null);
    return published;
  };

  beforeEach(async () => {
    f = await createOtaFixture();
    const staging = await f.ota.otaHosting.createChannel(f.appRow, f.ownerId, { name: 'staging', policy: null });
    channelId = staging.id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f.close();
  });

  it('serves the promoted update as multipart, with the exact signed bytes and a verifying signature', async () => {
    const { manifest } = await release();

    const response = await check();

    expect(response.status).toBe(200);
    expect(response.headers.get('expo-protocol-version')).toBe('1');
    expect(response.headers.get('expo-sfv-version')).toBe('0');
    expect(response.headers.get('cache-control')).toBe('private, max-age=0');
    const parts = partsOf(await response.text(), response.headers.get('content-type') ?? '');
    expect(parts.map(part => part.headers['content-disposition'])).toEqual([
      'form-data; name="manifest"',
      'form-data; name="extensions"',
    ]);
    const [manifestPart] = parts;
    expect(manifestPart?.body).toBe(manifest);
    expect(manifestPart !== undefined && isVerifiedOnDevice(manifestPart)).toBe(true);
  });

  it('answers 204 with the protocol headers when there is nothing new, or nothing at all', async () => {
    const { manifest } = await release();
    const { id } = JSON.parse(manifest) as { id: string };

    const responses = await Promise.all([
      check({ 'expo-current-update-id': id }),
      check({}, `${API}/ota/apps/${randomUUID()}/manifest`),
      check({}, `${API}/ota/apps/not-a-uuid/manifest`),
      check({ 'expo-channel-name': 'production' }),
      check({ 'expo-runtime-version': '2.0.0' }),
      check({ 'expo-platform': 'android' }),
    ]);

    expect(responses.map(response => response.status)).toEqual([204, 204, 204, 204, 204, 204]);
    expect(responses.every(response => response.headers.get('expo-protocol-version') === '1')).toBe(true);
  });

  it('refuses requests without protocol version 1, a platform or a runtime version', async () => {
    const responses = await Promise.all([
      check({ 'expo-protocol-version': '0' }),
      check({ 'expo-platform': 'web' }),
      check({ 'expo-runtime-version': '' }),
    ]);

    expect(responses.map(response => response.status)).toEqual([400, 400, 400]);
  });

  it('gives a JSON-only client the manifest with the signature as a response header', async () => {
    const { manifest } = await release();

    const response = await check({ accept: 'application/expo+json' });

    expect(response.headers.get('content-type')).toBe('application/expo+json');
    expect(await response.text()).toBe(manifest);
    expect(response.headers.get('expo-signature')).toMatch(/^sig=".+", keyid="root"$/u);
  });

  it('answers repeat checks from the cache, and a promotion here refreshes it at once', async () => {
    await release();
    const spy = vi.spyOn(ChannelHeadRepo.prototype, 'findServingState');

    await check();
    await check({ 'eas-client-id': 'device-2' });
    expect(spy).toHaveBeenCalledTimes(1);

    const next = await release(assetOf('console.log("v2")', 'application/javascript', 'bundle'));
    const response = await check();
    const [manifestPart] = partsOf(await response.text(), response.headers.get('content-type') ?? '');
    expect(manifestPart?.body).toBe(next.manifest);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('redirects an asset URL to its stored bytes, and 404s unknown assets', async () => {
    await release();

    const redirect = await f.app.fetch(new Request(`${f.assetBaseUrl}/${bundle.hash}`));
    expect(redirect.status).toBe(302);
    const bytes = await f.app.fetch(new Request(redirect.headers.get('location') ?? ''));
    expect(await bytes.text()).toBe(bundle.bytes);
    const unknown = await f.app.fetch(new Request(`${f.assetBaseUrl}/${'A'.repeat(43)}`));
    expect(unknown.status).toBe(404);
  });

  it('promotes from CI only ready, newer releases to unprotected channels, and audits it', async () => {
    const first = await f.publish();
    const promotionUrl = `${API}/ota/apps/${f.otaAppId}/releases/${first.releaseId}/promotions`;
    const promote = async (channel: string, url = promotionUrl) =>
      await f.call('POST', url, f.secretToken, { channel });

    const notReady = await promote('staging');
    expect(notReady.status).toBe(400);
    expect(((await notReady.json()) as { detail: string }).detail).toMatch(/is verifying; only ready releases/u);

    await f.ota.otaUploads.verifyAssets(first.releaseId);
    const status = await f.call('GET', `${API}/ota/apps/${f.otaAppId}/releases/${first.releaseId}`, f.secretToken);
    expect(await status.json()).toMatchObject({ status: OtaReleaseStatuses.ready });
    const promoted = await promote('staging');
    expect(promoted.status).toBe(201);
    const again = await promote('staging');
    expect(again.status).toBe(200);

    const second = await release(assetOf('console.log("v2")', 'application/javascript', 'bundle'));
    const older = await promote('staging');
    expect(older.status).toBe(409);
    expect(((await older.json()) as { detail: string }).detail).toMatch(/older than what "staging" serves/u);
    expect(second.releaseId).not.toBe(first.releaseId);

    await f.ota.otaHosting.createChannel(f.appRow, f.ownerId, {
      name: 'production',
      policy: { resume: [{ role: 'mobile-release', count: 1 }], prevent_self: true, reason_required: false },
    });
    const isProtected = await promote('production');
    expect(isProtected.status).toBe(403);
    const audit = await f.t.db.select().from(auditLog);
    expect(audit.filter(entry => entry.action === AuditActions.otaChannelChanged)).toHaveLength(2);
  });
});
