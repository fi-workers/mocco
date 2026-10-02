// What each product may store: the largest object and the content types it accepts.
// A product without an entry can't store anything — storage is opt-in per product.
import { Products } from '@mocco/common/project';

import type { Product } from '@mocco/common/project';

export interface StoragePolicy {
  maxBytes: number;
  /** Exact types (`application/json`) or a family ending in `/*` (`image/*`). */
  contentTypes: readonly string[];
}

const MiB = 1024 * 1024;

export const storagePolicies: Partial<Record<Product, StoragePolicy>> = {
  // OTA bundles and their assets (Expo Updates hosting).
  [Products.ota]: {
    maxBytes: 50 * MiB,
    contentTypes: [
      'application/javascript',
      'application/octet-stream',
      'application/json',
      'application/zip',
      'image/*',
      'font/*',
      'audio/*',
      'video/*',
    ],
  },
  // Images in help center articles, served publicly. No SVG: it can carry script.
  [Products.helpcenter]: {
    maxBytes: 10 * MiB,
    contentTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  },
  // Screenshots users attach to messenger conversations.
  [Products.messenger]: {
    maxBytes: 10 * MiB,
    contentTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  },
};

/** Default per-workspace quota across products (pending + ready bytes). */
export const DEFAULT_WORKSPACE_QUOTA_BYTES = 10 * 1024 * MiB;

/** How long an upload URL stays valid, and how long a pending upload is kept before gc. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a deleted object's row is kept (the audit of what existed) before gc drops it. */
export const DELETED_ROW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The media type without parameters, lowercased (`Image/PNG; q=1` → `image/png`). */
function mediaTypeOf(contentType: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- contentType is a string, never null
  return (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
}

function isMatch(allowed: string, type: string): boolean {
  // eslint-disable-next-line sonarjs/null-dereference -- both are strings, never null
  return allowed.endsWith('/*') ? type.startsWith(allowed.slice(0, -1)) : type === allowed;
}

export function isContentTypeAllowed(policy: StoragePolicy, contentType: string): boolean {
  const type = mediaTypeOf(contentType);
  return policy.contentTypes.some(allowed => isMatch(allowed, type));
}
