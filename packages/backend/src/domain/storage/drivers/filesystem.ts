// The filesystem ObjectStore driver: dev, tests and single-box self-host. Bytes live under
// `root/<key>`, with a `<key>.meta.json` sidecar for the content type, cache control and
// visibility. Clients reach it through the signed internal route
// (/api/ext/internal/storage/*, transport/ext/storage.ts), which calls `put`/`get`/`head`.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Visibilities, visibilitySchema } from '@mocco/common/storage';
import { z } from 'zod';

import { StorageOperations, type StorageUrlSigner } from '@backend/domain/storage/signing';

import type { ObjectHead, ObjectStore, UploadTarget } from '@backend/domain/storage/ports';
import type { Visibility } from '@mocco/common/storage';

const META_SUFFIX = '.meta.json';

const metaSchema = z.object({
  contentType: z.string(),
  cacheControl: z.string().optional(),
  visibility: visibilitySchema,
  etag: z.string(),
  size: z.number().int().nonnegative(),
});
type ObjectMeta = z.infer<typeof metaSchema>;

/** A key is a relative path of plain segments: no `..`, no empty or dot segments, no
 * backslashes, so it can never resolve outside the root. */
const KEY_SEGMENT = /^[\w.-]+$/u;
export function isSafeKey(key: string): boolean {
  // eslint-disable-next-line sonarjs/null-dereference -- key is a string, never null
  const segments = key.split('/');
  return (
    key.length > 0 &&
    key.length <= 1024 &&
    segments.every(segment => KEY_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
  );
}

export interface FilesystemObjectStoreOptions {
  /** Directory the objects live under (created on first write). */
  root: string;
  /** The internal route's absolute base, e.g. `https://www.mocco.work/api/ext/internal/storage`. */
  baseUrl: string;
  signer: StorageUrlSigner;
  now?: () => Date;
}

export class FilesystemObjectStore implements ObjectStore {
  private readonly now: () => Date;

  constructor(private readonly options: FilesystemObjectStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private pathOf(key: string): string {
    if (!isSafeKey(key)) {
      throw new Error('unsafe storage key');
    }
    // eslint-disable-next-line sonarjs/null-dereference -- key is a string, never null
    return path.join(this.options.root, ...key.split('/'));
  }

  private urlOf(key: string, query: Record<string, string>): string {
    const search = new URLSearchParams(query).toString();
    // eslint-disable-next-line sonarjs/null-dereference -- key is a string, never null
    const encoded = key
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
    const url = `${this.options.baseUrl}/${encoded}`;
    return search === '' ? url : `${url}?${search}`;
  }

  private expiresAt(expiresInSeconds: number): number {
    return Math.floor(this.now().getTime() / 1000) + expiresInSeconds;
  }

  /** The sidecar of an object, or null when it doesn't exist. */
  async meta(key: string): Promise<ObjectMeta | null> {
    try {
      return metaSchema.parse(JSON.parse(await readFile(`${this.pathOf(key)}${META_SUFFIX}`, 'utf8')));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async put(
    key: string,
    body: Uint8Array,
    opts: { contentType: string; cacheControl?: string; visibility: Visibility },
  ): Promise<{ etag: string }> {
    const file = this.pathOf(key);
    await mkdir(path.dirname(file), { recursive: true });
    const etag = createHash('sha256').update(body).digest('hex').slice(0, 32);
    await writeFile(file, body);
    const meta: ObjectMeta = {
      contentType: opts.contentType,
      ...(opts.cacheControl !== undefined && { cacheControl: opts.cacheControl }),
      visibility: opts.visibility,
      etag,
      size: body.byteLength,
    };
    await writeFile(`${file}${META_SUFFIX}`, JSON.stringify(meta));
    return { etag };
  }

  async get(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const meta = await this.meta(key);
    return meta === null ? null : new Uint8Array(await readFile(this.pathOf(key)));
  }

  async head(key: string): Promise<ObjectHead | null> {
    const meta = await this.meta(key);
    if (meta === null) {
      return null;
    }
    const { size } = await stat(this.pathOf(key));
    return { size, contentType: meta.contentType, etag: meta.etag };
  }

  async delete(keys: readonly string[]): Promise<void> {
    await Promise.all(
      keys.flatMap(key => {
        const file = this.pathOf(key);
        return [rm(file, { force: true }), rm(`${file}${META_SUFFIX}`, { force: true })];
      }),
    );
  }

  async createUploadUrl(
    key: string,
    opts: { contentType: string; maxBytes: number; expiresInSeconds: number; visibility: Visibility },
  ): Promise<UploadTarget> {
    const claims = {
      op: StorageOperations.put,
      key,
      expires: this.expiresAt(opts.expiresInSeconds),
      contentType: opts.contentType,
      maxBytes: opts.maxBytes,
      visibility: opts.visibility,
    };
    const url = this.urlOf(key, {
      op: claims.op,
      exp: String(claims.expires),
      ct: opts.contentType,
      max: String(opts.maxBytes),
      vis: opts.visibility,
      sig: this.options.signer.sign(claims),
    });
    return await Promise.resolve({ url, method: 'PUT', headers: { 'content-type': opts.contentType } });
  }

  publicUrl(key: string): string {
    return this.urlOf(key, {});
  }

  async signedDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    const claims = { op: StorageOperations.get, key, expires: this.expiresAt(expiresInSeconds) };
    return await Promise.resolve(
      this.urlOf(key, { op: claims.op, exp: String(claims.expires), sig: this.options.signer.sign(claims) }),
    );
  }
}

/** Whether an object's sidecar says it may be served without a signature. */
export function isPublic(meta: ObjectMeta | null): boolean {
  return meta?.visibility === Visibilities.public;
}
