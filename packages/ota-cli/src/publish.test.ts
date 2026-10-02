import { randomUUID, verify, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFingerprintPolicy, parseManifestUrl, readAppJson, runtimeVersionOf } from './app-config';
import { CERTIFICATE_FILE, init, KEY_FILE } from './init';
import { publish } from './publish';

import type { FinalizeRequest, UploadRequest } from '@mocco/common/ota-hosting';

const API = 'https://mocco.test/api/ext/v1';
const APP_ID = randomUUID();
const MANIFEST_URL = `${API}/ota/apps/${APP_ID}/manifest`;
const ASSET_BASE = `${API}/ota/apps/${APP_ID}/assets`;

// eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Uint8Array.fromBase64 isn't in Node 22
const signatureBytes = (sig: string) => Buffer.from(sig, 'base64');

const createdAtOf = (body: string) => new Date((JSON.parse(body) as { createdAt: string }).createdAt).getTime();

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

/** A Mocco stand-in: records requests and answers like the /v1 OTA routes. */
function fakeMocco(opts: { present?: readonly string[]; head?: { updateId: string; manifest: string } } = {}) {
  const requests: Recorded[] = [];
  const releaseId = randomUUID();
  const fetchImpl = async (input: string | URL | Request, request?: RequestInit) => {
    const url = String(input);
    const method = request?.method ?? 'GET';
    const body: unknown =
      typeof request?.body === 'string'
        ? JSON.parse(request.body)
        : (request?.body as Uint8Array | undefined)?.byteLength;
    requests.push({ method, url, body });
    if (url.endsWith('/ota/auth/oidc')) {
      return Response.json(
        { sessionToken: 'mk_ups_oidc', expiresAt: new Date(), allowedChannels: ['staging'] },
        { status: 201 },
      );
    }
    if (url.endsWith('/promotions')) {
      return Response.json({ channel: 'staging', releaseId, platforms: ['ios'], changed: true }, { status: 201 });
    }
    if (method === 'GET' && url.endsWith(`/ota/uploads/${releaseId}`)) {
      return Response.json({ id: releaseId, status: 'ready' });
    }
    if (url.endsWith('/upload-sessions')) {
      return Response.json({ sessionToken: 'mk_ups_test', expiresAt: new Date() }, { status: 201 });
    }
    if (url.endsWith('/ota/uploads')) {
      const declared = body as UploadRequest;
      return Response.json(
        {
          releaseId,
          assetBaseUrl: ASSET_BASE,
          missing: declared.assets
            .filter(asset => !(opts.present ?? []).includes(asset.hash))
            .map(asset => ({ hash: asset.hash, putUrl: `https://store.test/${asset.hash}`, headers: {} })),
          rollbackTargets: opts.head === undefined ? [] : [{ channel: 'production', platform: 'ios', ...opts.head }],
        },
        { status: 201 },
      );
    }
    if (url.endsWith('/finalize')) {
      const finalized = body as FinalizeRequest;
      const updates = Object.fromEntries(
        finalized.updates.map(update => [update.platform, (JSON.parse(update.body) as { id: string }).id]),
      );
      return Response.json({ releaseId, status: 'verifying', updates });
    }
    return new Response(null, { status: method === 'PUT' ? 200 : 404 });
  };
  return { requests, releaseId, fetch: fetchImpl };
}

describe('mocco-ota', () => {
  let projectDir: string;

  const writeExport = async () => {
    const dist = path.join(projectDir, 'dist');
    await mkdir(path.join(dist, '_expo/static/js/ios'), { recursive: true });
    await mkdir(path.join(dist, 'assets'), { recursive: true });
    await writeFile(path.join(dist, '_expo/static/js/ios/index-abc.hbc'), 'bundle-bytes');
    await writeFile(path.join(dist, 'assets/f00d'), 'png-bytes');
    await writeFile(
      path.join(dist, 'metadata.json'),
      JSON.stringify({
        version: 0,
        bundler: 'metro',
        fileMetadata: {
          ios: { bundle: '_expo/static/js/ios/index-abc.hbc', assets: [{ path: 'assets/f00d', ext: 'png' }] },
        },
      }),
    );
    return dist;
  };

  const publishWith = async (
    mocco: ReturnType<typeof fakeMocco>,
    extra: Partial<Parameters<typeof publish>[0]> = {},
  ) => {
    const { json } = await readAppJson(projectDir);
    return await publish({
      apiBase: API,
      appId: APP_ID,
      auth: { apiKey: 'mk_sec_test' },
      distDir: await writeExport(),
      platforms: ['ios'],
      runtimeVersion: '1.0.0',
      signingKeyPem: await readFile(path.join(projectDir, KEY_FILE), 'utf8'),
      keyid: 'root',
      message: 'Fix login',
      gitSha: 'abc1234',
      isMandatory: false,
      expoConfig: json.expo ?? {},
      fetch: mocco.fetch,
      ...extra,
    });
  };

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'mocco-ota-cli-'));
    await writeFile(path.join(projectDir, 'app.json'), JSON.stringify({ expo: { name: 'Acme', version: '1.0.0' } }));
    await init({ projectDir, manifestUrl: MANIFEST_URL, channel: 'production', keyid: 'root' });
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('init writes a key, a certificate and the updates block, and git-ignores the key', async () => {
    const { json } = await readAppJson(projectDir);

    expect(json.expo?.updates).toEqual({
      url: MANIFEST_URL,
      requestHeaders: { 'expo-channel-name': 'production' },
      codeSigningCertificate: `./${CERTIFICATE_FILE}`,
      codeSigningMetadata: { keyid: 'root', alg: 'rsa-v1_5-sha256' },
    });
    const certificate = new X509Certificate(await readFile(path.join(projectDir, CERTIFICATE_FILE)));
    expect(certificate.publicKey.asymmetricKeyType).toBe('rsa');
    expect(await readFile(path.join(projectDir, '.gitignore'), 'utf8')).toBe('keys/\n');
    await expect(init({ projectDir, manifestUrl: MANIFEST_URL, channel: 'production', keyid: 'root' })).rejects.toThrow(
      /already exists/u,
    );
  });

  it('uploads only missing assets and signs every body with the key the certificate verifies', async () => {
    const mocco = fakeMocco();
    const result = await publishWith(mocco);

    expect(result.releaseId).toBe(mocco.releaseId);
    expect(mocco.requests.map(request => request.method)).toEqual(['POST', 'POST', 'PUT', 'PUT', 'POST']);
    const finalize = mocco.requests.at(-1)?.body as FinalizeRequest;
    const certificate = new X509Certificate(await readFile(path.join(projectDir, CERTIFICATE_FILE)));
    const bodies = [...finalize.updates, ...finalize.directives];
    expect(
      bodies.every(signed =>
        verify('sha256', Buffer.from(signed.body), certificate.publicKey, signatureBytes(signed.signature?.sig ?? '')),
      ),
    ).toBe(true);
    const manifest = JSON.parse(finalize.updates[0]?.body ?? '{}') as {
      launchAsset: { url: string; hash: string; fileExtension: string };
      assets: { url: string }[];
      extra: { mocco: { gitSha: string }; expoClient: { name: string } };
    };
    expect(manifest.launchAsset.url).toBe(`${ASSET_BASE}/${manifest.launchAsset.hash}`);
    expect(manifest.launchAsset.fileExtension).toBe('.bundle');
    expect(manifest.extra).toMatchObject({ mocco: { gitSha: 'abc1234' }, expoClient: { name: 'Acme' } });
    const directive = JSON.parse(finalize.directives[0]?.body ?? '{}') as { parameters: { commitTime: string } };
    expect(new Date(directive.parameters.commitTime).getTime()).toBeGreaterThan(
      new Date((JSON.parse(finalize.updates[0]?.body ?? '{}') as { createdAt: string }).createdAt).getTime(),
    );
  });

  it('skips stored assets and pre-signs a later-dated republish of the channel head', async () => {
    const first = fakeMocco();
    await publishWith(first);
    const declared = first.requests[1]?.body as UploadRequest;
    const headManifest = (first.requests.at(-1)?.body as FinalizeRequest).updates[0]?.body ?? '';
    const second = fakeMocco({
      present: declared.assets.map(asset => asset.hash),
      head: { updateId: randomUUID(), manifest: headManifest },
    });

    const result = await publishWith(second);

    expect(result.uploadedBytes).toBe(0);
    expect(second.requests.some(request => request.method === 'PUT')).toBe(false);
    const finalize = second.requests.at(-1)?.body as FinalizeRequest;
    const [republish] = finalize.republishes;
    expect(createdAtOf(republish?.body ?? '')).toBeGreaterThan(createdAtOf(finalize.updates[0]?.body ?? ''));
  });

  it('publishes with a GitHub OIDC token, then promotes through the session once ready', async () => {
    const mocco = fakeMocco();

    await publishWith(mocco, { auth: { oidcToken: 'github-jwt' }, channel: 'staging' });

    expect(mocco.requests[0]).toMatchObject({
      method: 'POST',
      url: `${API}/ota/auth/oidc`,
      body: { appId: APP_ID, token: 'github-jwt' },
    });
    expect(mocco.requests.slice(-2).map(request => `${request.method} ${request.url.replace(API, '')}`)).toEqual([
      `GET /ota/uploads/${mocco.releaseId}`,
      `POST /ota/uploads/${mocco.releaseId}/promotions`,
    ]);
  });

  it('reads the API base and app id from the manifest URL, and the runtime version from app.json', () => {
    expect(parseManifestUrl(MANIFEST_URL)).toEqual({ apiBase: API, appId: APP_ID });
    expect(() => parseManifestUrl('https://u.expo.dev/abc')).toThrow(/isn't a Mocco manifest URL/u);
    expect(runtimeVersionOf({ runtimeVersion: '2.0' }, 'ios')).toBe('2.0');
    expect(runtimeVersionOf({ version: '1.4.0', runtimeVersion: { policy: 'appVersion' } }, 'ios')).toBe('1.4.0');
    expect(() => runtimeVersionOf({ runtimeVersion: { policy: 'fingerprint' } }, 'ios')).toThrow(
      /pass --runtime-version/u,
    );
  });

  it('singles out the fingerprint policy, which only the project Expo CLI can resolve', () => {
    expect(isFingerprintPolicy({ runtimeVersion: { policy: 'fingerprint' } })).toBe(true);
    expect(isFingerprintPolicy({ runtimeVersion: { policy: 'appVersion' } })).toBe(false);
    expect(isFingerprintPolicy({ runtimeVersion: '2.0' })).toBe(false);
    expect(isFingerprintPolicy({})).toBe(false);
  });
});
