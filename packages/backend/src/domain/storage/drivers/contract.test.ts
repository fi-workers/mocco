// One contract for every ObjectStore driver: the filesystem driver (through its signed
// internal route) and the S3 driver (against an in-process fake S3 over HTTP).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Visibilities } from '@mocco/common/storage';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { S3ObjectStore } from '@backend/domain/storage/drivers/s3';
import { StorageUrlSigner } from '@backend/domain/storage/signing';
import { startFakeS3, type FakeS3 } from '@backend/domain/storage/testing/fake-s3';
import { createStorageRoutes } from '@backend/transport/ext/storage';

import type { ObjectStore } from '@backend/domain/storage/ports';

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface Harness {
  store: ObjectStore;
  fetch: Fetcher;
  close: () => Promise<void>;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

const text = (body: Uint8Array | null) => (body === null ? null : new TextDecoder().decode(body));

const BASE = 'https://storage.test/api/ext/internal/storage';

async function filesystemHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'mocco-storage-'));
  const signer = new StorageUrlSigner('contract-signing-key');
  const store = new FilesystemObjectStore({ root, baseUrl: BASE, signer });
  const app = new Hono().basePath('/api/ext').route('/', createStorageRoutes({ store, signer }));
  return {
    store,
    fetch: async (url, init) => await app.fetch(new Request(url, init)),
    close: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function s3Harness(): Promise<Harness & { fake: FakeS3 }> {
  const fake = await startFakeS3();
  const store = new S3ObjectStore({
    bucket: fake.bucket,
    endpoint: fake.endpoint,
    region: 'auto',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    publicBaseUrl: 'https://cdn.test',
  });
  return { store, fake, fetch: async (url, init) => await fetch(url, init), close: fake.close };
}

const drivers: [string, () => Promise<Harness>][] = [
  ['filesystem', filesystemHarness],
  ['s3', s3Harness],
];

describe.each(drivers)('ObjectStore contract: %s', (_name, makeHarness) => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await makeHarness();
  });
  afterAll(async () => {
    await harness.close();
  });

  it('puts, heads and gets an object', async () => {
    await harness.store.put('prv/w/a/ota/1/main.jsbundle', bytes('console.log(1)'), {
      contentType: 'application/javascript',
      visibility: Visibilities.private,
    });

    expect(await harness.store.head('prv/w/a/ota/1/main.jsbundle')).toMatchObject({
      size: 14,
      contentType: 'application/javascript',
    });
    expect(text(await harness.store.get('prv/w/a/ota/1/main.jsbundle'))).toBe('console.log(1)');
  });

  it('answers null for a missing object', async () => {
    expect(await harness.store.head('prv/w/a/ota/missing/file')).toBeNull();
    expect(await harness.store.get('prv/w/a/ota/missing/file')).toBeNull();
  });

  it('deletes objects, and a missing key is not an error', async () => {
    await harness.store.put('prv/w/a/ota/2/a.json', bytes('{}'), {
      contentType: 'application/json',
      visibility: Visibilities.private,
    });
    await harness.store.delete(['prv/w/a/ota/2/a.json', 'prv/w/a/ota/2/never-existed.json']);
    expect(await harness.store.head('prv/w/a/ota/2/a.json')).toBeNull();
  });

  it('accepts an upload to its presigned URL', async () => {
    const target = await harness.store.createUploadUrl('prv/w/a/ota/3/asset.png', {
      contentType: 'image/png',
      maxBytes: 4,
      expiresInSeconds: 60,
      visibility: Visibilities.private,
    });

    const response = await harness.fetch(target.url, { method: target.method, headers: target.headers, body: 'png!' });

    expect(response.ok).toBe(true);
    expect(await harness.store.head('prv/w/a/ota/3/asset.png')).toMatchObject({ size: 4, contentType: 'image/png' });
  });

  it('serves a private object through a signed download URL', async () => {
    await harness.store.put('prv/w/a/ota/4/notes.json', bytes('{"a":1}'), {
      contentType: 'application/json',
      visibility: Visibilities.private,
    });

    const response = await harness.fetch(await harness.store.signedDownloadUrl('prv/w/a/ota/4/notes.json', 60));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"a":1}');
  });

  it('serves a signed download as an attachment when asked to', async () => {
    await harness.store.put('prv/w/a/messenger/8/invoice.pdf', bytes('%PDF-1.7'), {
      contentType: 'application/pdf',
      visibility: Visibilities.private,
    });

    const [download, inline] = await Promise.all([
      harness.fetch(
        await harness.store.signedDownloadUrl('prv/w/a/messenger/8/invoice.pdf', 60, { downloadAs: 'invoice.pdf' }),
      ),
      harness.fetch(await harness.store.signedDownloadUrl('prv/w/a/messenger/8/invoice.pdf', 60)),
    ]);

    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="invoice.pdf"');
    expect(await download.text()).toBe('%PDF-1.7');
    expect(inline.headers.get('content-disposition')).toBeNull();
  });
});

describe('filesystem driver route', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await filesystemHarness();
  });
  afterAll(async () => {
    await harness.close();
  });

  it('refuses a private object without a signature, and a tampered or expired one', async () => {
    await harness.store.put('prv/w/a/ota/5/secret.json', bytes('{}'), {
      contentType: 'application/json',
      visibility: Visibilities.private,
    });
    const signed = await harness.store.signedDownloadUrl('prv/w/a/ota/5/secret.json', 60);

    const expired = await harness.store.signedDownloadUrl('prv/w/a/ota/5/secret.json', -1);
    const responses = await Promise.all([
      harness.fetch(harness.store.publicUrl('prv/w/a/ota/5/secret.json')),
      harness.fetch(signed.replace('secret.json', 'other.json')),
      harness.fetch(signed.replace(/exp=\d+/u, 'exp=9999999999')),
      harness.fetch(expired),
    ]);

    expect(responses.map(response => response.status)).toEqual([404, 404, 404, 404]);
  });

  it('serves a public object without a signature', async () => {
    await harness.store.put('pub/w/a/ota/6/logo.png', bytes('png'), {
      contentType: 'image/png',
      visibility: Visibilities.public,
    });

    const response = await harness.fetch(harness.store.publicUrl('pub/w/a/ota/6/logo.png'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
  });

  it('rejects an upload that breaks the signed limits', async () => {
    const target = await harness.store.createUploadUrl('prv/w/a/ota/7/x.json', {
      contentType: 'application/json',
      maxBytes: 2,
      expiresInSeconds: 60,
      visibility: Visibilities.private,
    });

    const tooBig = await harness.fetch(target.url, { method: 'PUT', headers: target.headers, body: '{"a":1}' });
    const wrongType = await harness.fetch(target.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: '{}',
    });
    const madePublic = await harness.fetch(target.url.replace('vis=private', 'vis=public'), {
      method: 'PUT',
      headers: target.headers,
      body: '{}',
    });

    expect([tooBig.status, wrongType.status, madePublic.status]).toEqual([413, 400, 403]);
    expect(await harness.store.head('prv/w/a/ota/7/x.json')).toBeNull();
  });

  it('refuses a key that escapes the root', async () => {
    const response = await harness.fetch(`${BASE}/..%2F..%2Fetc/passwd`);
    expect(response.status).toBe(404);
  });
});
