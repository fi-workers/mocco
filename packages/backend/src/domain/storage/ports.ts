import type { Visibility } from '@mocco/common/storage';

/** What a store knows about one object. */
export interface ObjectHead {
  size: number;
  contentType: string;
  etag: string;
}

/** A presigned upload: the client sends the bytes there itself, never through Mocco. */
export interface UploadTarget {
  url: string;
  method: 'PUT';
  /** Headers the client must send with the upload (the content type the URL is signed for). */
  headers: Record<string, string>;
}

/**
 * The neutral object-store port (platform foundations §10). Drivers are leaves:
 * `s3` (AWS S3, Cloudflare R2, MinIO, Supabase Storage's S3 endpoint) and `filesystem`
 * (dev, tests, single-box self-host). Keys are opaque to a driver; StorageService owns
 * their layout and the ledger.
 */
export interface ObjectStore {
  put(
    key: string,
    body: Uint8Array,
    opts: { contentType: string; cacheControl?: string; visibility: Visibility },
  ): Promise<{ etag: string }>;
  /** The bytes, or null when there is no such object. Objects are capped per product
   * (StoragePolicy.maxBytes), so reading one into memory is bounded. */
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  head(key: string): Promise<ObjectHead | null>;
  /** Delete the keys; a missing key is not an error. */
  delete(keys: readonly string[]): Promise<void>;
  /** A URL the client can upload one object to, before `expiresInSeconds`. */
  createUploadUrl(
    key: string,
    opts: { contentType: string; maxBytes: number; expiresInSeconds: number; visibility: Visibility },
  ): Promise<UploadTarget>;
  /** The stable URL of a public object (behind the CDN). */
  publicUrl(key: string): string;
  /** A URL that reads a private object until it expires. */
  signedDownloadUrl(key: string, expiresInSeconds: number): Promise<string>;
}
