// Uploads a status page's public files through the storage domain's ObjectStore (ADR 0028): the
// `s3` driver for hosted (behind the CDN), the `filesystem` driver for self-host, where any static
// server can serve the directory. A version's files are immutable; the page-level copies and the
// `current.json` pointer are short-lived, and the pointer is written last, so a reader never sees
// a version whose files aren't all there.
import { Visibilities } from '@mocco/common/storage';

import type { ObjectStore } from '@backend/domain/storage/ports';

/** Where every status page lives in the store: `pub/status/{slug}/…`. Public objects only. */
export const STATUS_PUBLIC_PREFIX = 'pub/status';

export const StatusCacheControls = {
  /** A version's files never change. */
  immutable: 'public, max-age=31536000, immutable',
  /** The pointer and the page-level copies: fresh within seconds, and served stale for a week
   * if the origin fails, so the page outlives an outage of the store or of Mocco. */
  pointer: 'public, max-age=15, stale-while-revalidate=60, stale-if-error=604800',
} as const;

const ContentTypes = {
  json: 'application/json',
  html: 'text/html; charset=utf-8',
  atom: 'application/atom+xml; charset=utf-8',
} as const;

/** The rendered files of one version. */
export interface VersionFiles {
  snapshot: string;
  /** The page as served from `/{slug}/`. */
  page: string;
  /** The same page for `/{slug}/v/{version}/` (its links climb two levels). */
  versionPage: string;
  feed: string;
  /** `current.json`. */
  pointer: string;
}

const encoder = new TextEncoder();

export class StaticPublisher {
  static keyOf(slug: string, path: string): string {
    return `${STATUS_PUBLIC_PREFIX}/${slug}/${path}`;
  }

  constructor(private readonly store: ObjectStore) {}

  private async put(slug: string, path: string, body: string, contentType: string, cacheControl: string) {
    await this.store.put(StaticPublisher.keyOf(slug, path), encoder.encode(body), {
      contentType,
      cacheControl,
      visibility: Visibilities.public,
    });
  }

  /** Upload the version, then the page-level copies, then flip the pointer. */
  async publish(slug: string, version: number, files: VersionFiles): Promise<void> {
    const { immutable, pointer } = StatusCacheControls;
    await Promise.all([
      this.put(slug, `v/${version}/snapshot.json`, files.snapshot, ContentTypes.json, immutable),
      this.put(slug, `v/${version}/index.html`, files.versionPage, ContentTypes.html, immutable),
      this.put(slug, `v/${version}/feed.atom`, files.feed, ContentTypes.atom, immutable),
    ]);
    await Promise.all([
      this.put(slug, 'index.html', files.page, ContentTypes.html, pointer),
      this.put(slug, 'feed.atom', files.feed, ContentTypes.atom, pointer),
    ]);
    await this.put(slug, 'current.json', files.pointer, ContentTypes.json, pointer);
  }

  /** Delete old versions' files. */
  async deleteVersions(slug: string, versions: readonly number[]): Promise<void> {
    await this.store.delete(
      versions.flatMap(version =>
        ['snapshot.json', 'index.html', 'feed.atom'].map(file => StaticPublisher.keyOf(slug, `v/${version}/${file}`)),
      ),
    );
  }
}
