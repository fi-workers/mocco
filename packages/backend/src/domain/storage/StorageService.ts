import { randomUUID } from 'node:crypto';

import { ObjectStatuses, Visibilities } from '@mocco/common/storage';

import {
  StorageContentTypeNotAllowedError,
  StorageObjectTooLargeError,
  StorageProductNotAllowedError,
  StorageQuotaExceededError,
  StorageUploadMismatchError,
  StoredObjectNotFoundError,
} from '@backend/domain/storage/errors';
import {
  DEFAULT_WORKSPACE_QUOTA_BYTES,
  DELETED_ROW_TTL_MS,
  isContentTypeAllowed,
  PENDING_UPLOAD_TTL_MS,
  storagePolicies,
  UPLOAD_URL_TTL_SECONDS,
} from '@backend/domain/storage/policy';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { ObjectHead, ObjectStore, UploadTarget } from '@backend/domain/storage/ports';
import type { ObjectRepo, StoredObjectRow } from '@backend/domain/storage/repos/object.repo';
import type { Product } from '@mocco/common/project';
import type { Visibility } from '@mocco/common/storage';

/** Where stored bytes are counted (the `storage_bytes` meter). A no-op until usage
 * metering (platform foundations §14) lands. */
export interface StorageUsage {
  record(event: { workspaceId: string; product: string; meter: 'storage_bytes'; quantity: number }): Promise<void>;
}

const noUsage: StorageUsage = { record: async () => {} };

export interface StorageServiceDeps {
  objects: ObjectRepo;
  store: ObjectStore;
  usage?: StorageUsage;
  quotaBytes?: number;
  now?: () => Date;
}

export interface ObjectInput {
  workspaceId: string;
  projectId: string | null;
  product: Product;
  filename: string;
  contentType: string;
  sizeBytes: number;
  visibility: Visibility;
  sha256?: string;
  createdByUserId?: string;
}

/** Who an object belongs to beyond its workspace: the project, product and visibility it was reserved for. */
export interface ObjectOwner {
  projectId: string | null;
  product: Product;
  visibility: Visibility;
}

function isOwnedBy(object: StoredObjectRow, owner: ObjectOwner): boolean {
  return (
    object.projectId === owner.projectId && object.product === owner.product && object.visibility === owner.visibility
  );
}

const EDGE_CHARS = new Set(['-', '.']);

/** Drop leading and trailing dots and dashes (no regex: a linear scan). */
function trimEdges(value: string): string {
  const chars = [...value];
  const start = chars.findIndex(char => !EDGE_CHARS.has(char));
  if (start === -1) {
    return '';
  }
  const end = chars.findLastIndex(char => !EDGE_CHARS.has(char));
  return chars.slice(start, end + 1).join('');
}

/** A filename safe in a key and a URL: lowercase letters, digits, dot, dash, underscore. */
export function safeFilename(filename: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- filename is a string, never null
  const cleaned = trimEdges(filename.toLowerCase().replaceAll(/[^a-z0-9._-]+/gu, '-')).slice(0, 100);
  return cleaned === '' ? 'file' : cleaned;
}

/** Why stored bytes don't match the declared object, or null when they do. */
function mismatchOf(object: StoredObjectRow, head: ObjectHead | null): string | null {
  if (head === null) {
    return 'nothing was uploaded';
  }
  if (head.size !== object.sizeBytes) {
    return `expected ${object.sizeBytes} bytes, got ${head.size}`;
  }
  if (head.contentType !== object.contentType) {
    return `expected ${object.contentType}, got ${head.contentType}`;
  }
  return null;
}

/** `pub/…` or `prv/…`, so a CDN or bucket policy can expose only the public prefix. */
function keyOf(id: string, input: ObjectInput): string {
  const prefix = input.visibility === Visibilities.public ? 'pub' : 'prv';
  const project = input.projectId === null ? '' : `p/${input.projectId}/`;
  return `${prefix}/w/${input.workspaceId}/${project}${input.product}/${id}/${safeFilename(input.filename)}`;
}

/**
 * Object storage (platform foundations §10): the ledger plus the configured store.
 * Uploads are two-phase — `beginUpload` checks policy and quota, records a `pending` row
 * and returns a presigned URL; the client uploads straight to the store; `completeUpload`
 * verifies the bytes with `head` and marks the row `ready`. The daily `storage.gc` job
 * removes abandoned uploads and old deleted rows.
 */
export class StorageService {
  private readonly now: () => Date;

  private readonly usage: StorageUsage;

  private readonly quotaBytes: number;

  constructor(private readonly deps: StorageServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.usage = deps.usage ?? noUsage;
    this.quotaBytes = deps.quotaBytes ?? DEFAULT_WORKSPACE_QUOTA_BYTES;
  }

  /** Check product policy and the workspace quota for a new object of `input`. */
  private async admit(input: ObjectInput): Promise<void> {
    const policy = storagePolicies[input.product];
    if (policy === undefined) {
      throw new StorageProductNotAllowedError(input.product);
    }
    if (!isContentTypeAllowed(policy, input.contentType)) {
      throw new StorageContentTypeNotAllowedError(input.contentType);
    }
    if (input.sizeBytes > policy.maxBytes) {
      throw new StorageObjectTooLargeError(policy.maxBytes);
    }
    if ((await this.deps.objects.usedBytes(input.workspaceId)) + input.sizeBytes > this.quotaBytes) {
      throw new StorageQuotaExceededError();
    }
  }

  private async requireObject(workspaceId: string, objectId: string): Promise<StoredObjectRow> {
    try {
      return await this.deps.objects.getInWorkspace(workspaceId, objectId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new StoredObjectNotFoundError(objectId, { cause: error });
      }
      throw error;
    }
  }

  /** Reserve an object and return the URL the client uploads it to. */
  async beginUpload(input: ObjectInput): Promise<{ object: StoredObjectRow; upload: UploadTarget }> {
    await this.admit(input);
    const id = randomUUID();
    const key = keyOf(id, input);
    const object = await this.deps.objects.insert({
      id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      product: input.product,
      key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256 ?? null,
      visibility: input.visibility,
      createdByUserId: input.createdByUserId ?? null,
      // The service's clock, so the gc job's age check uses the same time source.
      createdAt: this.now(),
    });
    const upload = await this.deps.store.createUploadUrl(key, {
      contentType: input.contentType,
      maxBytes: input.sizeBytes,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      visibility: input.visibility,
    });
    return { object, upload };
  }

  /**
   * Verify an upload and mark it ready. The stored bytes must exist, be exactly the
   * declared size and have the declared content type; otherwise they are deleted, the
   * row is marked deleted and StorageUploadMismatchError is thrown. With `owner`, an object
   * of another project, product or visibility is not found, so a client-supplied id can
   * only complete what that product reserved.
   */
  async completeUpload(workspaceId: string, objectId: string, owner?: ObjectOwner): Promise<StoredObjectRow> {
    const object = await this.requireObject(workspaceId, objectId);
    if (owner !== undefined && !isOwnedBy(object, owner)) {
      throw new StoredObjectNotFoundError(objectId);
    }
    if (object.status === ObjectStatuses.ready) {
      return object;
    }
    if (object.status !== ObjectStatuses.pending) {
      throw new StoredObjectNotFoundError(objectId);
    }
    const reason = mismatchOf(object, await this.deps.store.head(object.key));
    if (reason !== null) {
      await this.deps.store.delete([object.key]);
      await this.deps.objects.markDeleted([object.id], this.now());
      throw new StorageUploadMismatchError(reason);
    }
    const ready = (await this.deps.objects.markReady(workspaceId, object.id, object.sizeBytes, this.now())) ?? object;
    await this.usage.record({
      workspaceId,
      product: object.product,
      meter: 'storage_bytes',
      quantity: object.sizeBytes,
    });
    return ready;
  }

  /**
   * A ready object of the project and product whose declared sha256 matches, to reuse
   * instead of storing the same bytes again. The hash is the uploader's declaration, so
   * reuse stays within one project and product.
   */
  async findReady(input: {
    workspaceId: string;
    projectId: string;
    product: Product;
    visibility: Visibility;
    sha256: string;
  }): Promise<StoredObjectRow | undefined> {
    return await this.deps.objects.findReadyBySha256(input);
  }

  /** Store bytes the server already has (no client upload), recorded ready at once. */
  async putObject(input: Omit<ObjectInput, 'sizeBytes'> & { body: Uint8Array; cacheControl?: string }) {
    const declared: ObjectInput = { ...input, sizeBytes: input.body.byteLength };
    await this.admit(declared);
    const id = randomUUID();
    const key = keyOf(id, declared);
    await this.deps.store.put(key, input.body, {
      contentType: input.contentType,
      visibility: input.visibility,
      ...(input.cacheControl !== undefined && { cacheControl: input.cacheControl }),
    });
    const object = await this.deps.objects.insert({
      id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      product: input.product,
      key,
      contentType: input.contentType,
      sizeBytes: declared.sizeBytes,
      sha256: input.sha256 ?? null,
      visibility: input.visibility,
      status: ObjectStatuses.ready,
      readyAt: this.now(),
      createdByUserId: input.createdByUserId ?? null,
      createdAt: this.now(),
    });
    await this.usage.record({
      workspaceId: input.workspaceId,
      product: input.product,
      meter: 'storage_bytes',
      quantity: declared.sizeBytes,
    });
    return object;
  }

  /** A URL to read a ready object: the stable CDN URL for public objects, an expiring
   * signed one for private objects. */
  async downloadUrl(workspaceId: string, objectId: string, expiresInSeconds = 300): Promise<string> {
    const object = await this.requireObject(workspaceId, objectId);
    if (object.status !== ObjectStatuses.ready) {
      throw new StoredObjectNotFoundError(objectId);
    }
    return object.visibility === Visibilities.public
      ? this.deps.store.publicUrl(object.key)
      : await this.deps.store.signedDownloadUrl(object.key, expiresInSeconds);
  }

  /** The bytes of a ready object (bounded by its product's maxBytes), or null when the
   * store has lost them. */
  async read(workspaceId: string, objectId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const object = await this.requireObject(workspaceId, objectId);
    if (object.status !== ObjectStatuses.ready) {
      throw new StoredObjectNotFoundError(objectId);
    }
    return await this.deps.store.get(object.key);
  }

  /** Delete an object: its bytes now, its row after the retention window. */
  async delete(workspaceId: string, objectId: string): Promise<void> {
    const object = await this.requireObject(workspaceId, objectId);
    if (object.status === ObjectStatuses.deleted) {
      return;
    }
    await this.deps.store.delete([object.key]);
    await this.deps.objects.markDeleted([object.id], this.now());
  }

  /** The `storage.gc` job: delete abandoned pending uploads (bytes and all) and drop the
   * rows of objects deleted longer than the retention window. Batched, so a backlog
   * drains over several runs. */
  async collectGarbage(opts: { batchSize?: number } = {}): Promise<{ abandoned: number; dropped: number }> {
    const batchSize = opts.batchSize ?? 500;
    const now = this.now();
    const stale = await this.deps.objects.listStalePending(new Date(now.getTime() - PENDING_UPLOAD_TTL_MS), batchSize);
    await this.deps.store.delete(stale.map(object => object.key));
    await this.deps.objects.markDeleted(
      stale.map(object => object.id),
      now,
    );
    const expired = await this.deps.objects.listExpiredDeleted(new Date(now.getTime() - DELETED_ROW_TTL_MS), batchSize);
    await this.deps.store.delete(expired.map(object => object.key));
    await this.deps.objects.hardDelete(expired.map(object => object.id));
    return { abandoned: stale.length, dropped: expired.length };
  }

  /** The store itself, for products that publish fixed public files outside the ledger
   * (status pages, ADR 0028). */
  get store(): ObjectStore {
    return this.deps.store;
  }
}
