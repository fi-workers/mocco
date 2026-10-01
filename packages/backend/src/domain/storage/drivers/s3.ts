// The S3-compatible ObjectStore driver: AWS S3, Cloudflare R2 (the hosted recommendation:
// free egress), MinIO, Supabase Storage's S3 endpoint, Naver Cloud Object Storage. The
// only file that imports the AWS SDK (vendor isolation). Uploads and private reads go
// through presigned URLs, so bytes never pass through Mocco's functions.
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { ObjectHead, ObjectStore, UploadTarget } from '@backend/domain/storage/ports';

export interface S3ObjectStoreOptions {
  bucket: string;
  /** Custom endpoint for R2, MinIO and others; omit for AWS. */
  endpoint?: string;
  /** `auto` for R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The CDN (or public bucket) origin that serves public objects, without a trailing slash. */
  publicBaseUrl?: string;
  /** Path-style addressing (`<endpoint>/<bucket>/<key>`), needed by MinIO and fakes. */
  forcePathStyle?: boolean;
}

/** S3 DeleteObjects takes at most 1,000 keys per request. */
const DELETE_BATCH = 1000;

const isNotFound = (error: unknown) =>
  error instanceof S3ServiceException && (error.name === 'NotFound' || error.name === 'NoSuchKey');

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(private readonly options: S3ObjectStoreOptions) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint !== undefined && { endpoint: options.endpoint }),
      forcePathStyle: options.forcePathStyle ?? options.endpoint !== undefined,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // R2 and most S3-compatible stores reject the SDK's default request checksums.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(key: string, body: Uint8Array, opts: { contentType: string; cacheControl?: string }) {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        ...(opts.cacheControl !== undefined && { CacheControl: opts.cacheControl }),
      }),
    );
    return { etag: result.ETag ?? '' };
  }

  async get(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
      const bytes = await result.Body?.transformToByteArray();
      return bytes === undefined ? null : new Uint8Array(bytes);
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return {
        size: result.ContentLength ?? 0,
        contentType: result.ContentType ?? '',
        etag: result.ETag ?? '',
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async delete(keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += DELETE_BATCH) {
      const batch = keys.slice(start, start + DELETE_BATCH);
      // eslint-disable-next-line no-await-in-loop -- batches go one after another to stay under the store's rate limits
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.options.bucket,
          Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  async createUploadUrl(key: string, opts: { contentType: string; expiresInSeconds: number }): Promise<UploadTarget> {
    // A presigned PUT can't cap the size; StorageService.completeUpload checks it with
    // `head` and deletes an object that doesn't match what was declared.
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.options.bucket, Key: key, ContentType: opts.contentType }),
      { expiresIn: opts.expiresInSeconds },
    );
    return { url, method: 'PUT', headers: { 'content-type': opts.contentType } };
  }

  publicUrl(key: string): string {
    if (this.options.publicBaseUrl === undefined) {
      throw new Error('STORAGE_PUBLIC_BASE_URL is not set, so public objects have no URL');
    }
    return `${this.options.publicBaseUrl}/${key}`;
  }

  async signedDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    return await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}
