import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Products } from '@mocco/common/project';
import { ObjectStatuses, Visibilities } from '@mocco/common/storage';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { PENDING_UPLOAD_TTL_MS } from '@backend/domain/storage/policy';
import { ObjectRepo } from '@backend/domain/storage/repos/object.repo';
import { StorageUrlSigner } from '@backend/domain/storage/signing';
import { StorageService } from '@backend/domain/storage/StorageService';
import { expectOne } from '@backend/infra/db/rows';
import { objects, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createStorageRoutes } from '@backend/transport/ext/storage';

import type { ObjectInput } from '@backend/domain/storage/StorageService';

const BASE = 'https://storage.test/api/ext/internal/storage';

describe('StorageService (pglite + filesystem store)', () => {
  let t: TestDb;
  let root: string;
  let store: FilesystemObjectStore;
  let app: Hono;
  let workspaceId: string;
  let now: Date;
  let usage: { workspaceId: string; product: string; quantity: number }[];

  const service = (quotaBytes?: number) =>
    new StorageService({
      objects: new ObjectRepo(t.db),
      store,
      now: () => now,
      usage: {
        record: async event => {
          usage.push(event);
          await Promise.resolve();
        },
      },
      ...(quotaBytes !== undefined && { quotaBytes }),
    });

  const input = (overrides: Partial<ObjectInput> = {}): ObjectInput => ({
    workspaceId,
    projectId: null,
    product: Products.ota,
    filename: 'Main Bundle.js',
    contentType: 'application/javascript',
    sizeBytes: 5,
    visibility: Visibilities.private,
    ...overrides,
  });

  const upload = async (url: string, headers: Record<string, string>, body: string) =>
    await app.fetch(new Request(url, { method: 'PUT', headers, body }));

  beforeEach(async () => {
    t = await createTestDb();
    root = await mkdtemp(path.join(tmpdir(), 'mocco-storage-svc-'));
    const signer = new StorageUrlSigner('svc-signing-key');
    store = new FilesystemObjectStore({ root, baseUrl: BASE, signer, now: () => now });
    app = new Hono().basePath('/api/ext').route('/', createStorageRoutes({ store, signer, now: () => now }));
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    now = new Date('2026-10-01T00:00:00Z');
    usage = [];
  });
  afterEach(async () => {
    await t.close();
    await rm(root, { recursive: true, force: true });
  });

  it('reserves an object under a safe, scoped key and completes it after the upload', async () => {
    const storage = service();
    const { object, upload: target } = await storage.beginUpload(input());

    expect(object.status).toBe(ObjectStatuses.pending);
    expect(object.key).toBe(`prv/w/${workspaceId}/ota/${object.id}/main-bundle.js`);
    const uploaded = await upload(target.url, target.headers, 'hello');
    expect(uploaded.status).toBe(200);

    const ready = await storage.completeUpload(workspaceId, object.id);

    expect(ready.status).toBe(ObjectStatuses.ready);
    expect(usage).toEqual([{ workspaceId, product: Products.ota, meter: 'storage_bytes', quantity: 5 }]);
    const download = await app.fetch(new Request(await storage.downloadUrl(workspaceId, object.id)));
    expect(await download.text()).toBe('hello');
  });

  it('refuses products without a policy, disallowed types and oversized objects', async () => {
    const storage = service();
    await expect(storage.beginUpload(input({ product: Products.forum }))).rejects.toThrow(/can't store objects/u);
    await expect(storage.beginUpload(input({ contentType: 'text/html' }))).rejects.toThrow(/isn't allowed/u);
    await expect(storage.beginUpload(input({ sizeBytes: 51 * 1024 * 1024 }))).rejects.toThrow(/at most/u);
    expect(await t.db.select().from(objects)).toHaveLength(0);
  });

  it('enforces the workspace quota across pending and ready objects', async () => {
    const storage = service(8);
    await storage.beginUpload(input({ sizeBytes: 5 }));

    await expect(storage.beginUpload(input({ sizeBytes: 4 }))).rejects.toThrow(/quota/u);
    await expect(storage.beginUpload(input({ sizeBytes: 3 }))).resolves.toBeDefined();
  });

  it('rejects a completion whose bytes are missing or a different size, and deletes them', async () => {
    const storage = service();
    const missing = await storage.beginUpload(input());
    await expect(storage.completeUpload(workspaceId, missing.object.id)).rejects.toThrow(/nothing was uploaded/u);

    const short = await storage.beginUpload(input({ sizeBytes: 5 }));
    // The signed URL allows up to 5 bytes, so a 3-byte upload gets through the route.
    await upload(short.upload.url, short.upload.headers, 'hey');
    await expect(storage.completeUpload(workspaceId, short.object.id)).rejects.toThrow(/expected 5 bytes, got 3/u);

    expect(await store.head(short.object.key)).toBeNull();
    const rows = await t.db.select().from(objects);
    expect(rows.map(row => row.status)).toEqual([ObjectStatuses.deleted, ObjectStatuses.deleted]);
    expect(usage).toHaveLength(0);
  });

  it('only reads ready objects of the same workspace', async () => {
    const storage = service();
    const { object } = await storage.beginUpload(input());
    const other = expectOne(await t.db.insert(workspaces).values({ name: 'O', slug: randomUUID() }).returning()).id;

    await expect(storage.downloadUrl(workspaceId, object.id)).rejects.toThrow(/not found/u);
    await expect(storage.downloadUrl(other, object.id)).rejects.toThrow(/not found/u);
  });

  it('stores server-side bytes as ready, with a stable public URL for public objects', async () => {
    const storage = service();
    const object = await storage.putObject({
      ...input({ visibility: Visibilities.public, filename: 'icon.png', contentType: 'image/png' }),
      body: new TextEncoder().encode('png'),
    });

    expect(object).toMatchObject({ status: ObjectStatuses.ready, sizeBytes: 3 });
    const url = await storage.downloadUrl(workspaceId, object.id);
    expect(url).not.toContain('sig=');
    const served = await app.fetch(new Request(url));
    expect(served.status).toBe(200);
  });

  it('collects abandoned uploads after a day and drops deleted rows after the retention window', async () => {
    const storage = service();
    const abandoned = await storage.beginUpload(input());
    await upload(abandoned.upload.url, abandoned.upload.headers, 'hello');
    const kept = await storage.putObject({ ...input(), body: new TextEncoder().encode('keep!') });
    const removed = await storage.putObject({ ...input(), body: new TextEncoder().encode('gone!') });
    await storage.delete(workspaceId, removed.id);

    now = new Date(now.getTime() + PENDING_UPLOAD_TTL_MS + 1000);
    expect(await storage.collectGarbage()).toEqual({ abandoned: 1, dropped: 0 });
    expect(await store.head(abandoned.object.key)).toBeNull();

    now = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(await storage.collectGarbage()).toEqual({ abandoned: 0, dropped: 2 });
    const rows = await t.db.select().from(objects).where(eq(objects.workspaceId, workspaceId));
    expect(rows.map(row => row.id)).toEqual([kept.id]);
  });
});
