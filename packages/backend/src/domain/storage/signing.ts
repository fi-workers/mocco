// Signed URLs for the filesystem driver's internal route (/api/ext/internal/storage/*).
// The route has no session: a request is allowed only if its query carries a valid
// HMAC over the operation, the key, the expiry and the upload limits, so a URL can't be
// reused for another key, another operation or past its expiry.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a signed storage URL lets its holder do. */
export const StorageOperations = {
  get: 'get',
  put: 'put',
} as const;
export type StorageOperation = (typeof StorageOperations)[keyof typeof StorageOperations];

export interface SignedStorageClaims {
  op: StorageOperation;
  key: string;
  /** Unix seconds after which the URL is refused. */
  expires: number;
  /** For `put`: the content type the upload must declare. */
  contentType?: string;
  /** For `put`: the most bytes the upload may carry. */
  maxBytes?: number;
  /** For `put`: the visibility the stored object gets. */
  visibility?: string;
}

const canonical = (claims: SignedStorageClaims) =>
  [
    claims.op,
    claims.key,
    String(claims.expires),
    claims.contentType ?? '',
    String(claims.maxBytes ?? ''),
    claims.visibility ?? '',
  ].join('\n');

/** HMAC-SHA256 signer and verifier for storage URLs. */
export class StorageUrlSigner {
  constructor(private readonly secret: string) {}

  sign(claims: SignedStorageClaims): string {
    return createHmac('sha256', this.secret).update(canonical(claims)).digest('base64url');
  }

  /** Whether `signature` matches the claims and they haven't expired at `nowSeconds`. */
  isValid(claims: SignedStorageClaims, signature: string, nowSeconds: number): boolean {
    if (!Number.isFinite(claims.expires) || claims.expires < nowSeconds) {
      return false;
    }
    const expected = Buffer.from(this.sign(claims));
    const presented = Buffer.from(signature);
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  }
}
