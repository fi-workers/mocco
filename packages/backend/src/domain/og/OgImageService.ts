// Open Graph images (ADR 0030). A page asks `issue` for its card's path; the path carries
// the fields as data and a signature over the template's version and that data, keyed by
// a server secret, so only Mocco can mint an image and nobody can make our domain render
// their text. The image route asks `image`: a bad signature is a 404; otherwise the PNG is
// read from object storage, or rendered once and stored under the signature. Any change to
// the fields or the template's look is a new signature, so a new URL — the only refresh
// KakaoTalk's unpurgeable cache, and every other unfurl cache, honors.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { Visibilities } from '@mocco/common/storage';

import { OG_HEIGHT, OG_WIDTH, ogTemplateSchema, OgTemplates } from '@backend/domain/og/templates';

import type { OgRenderer } from '@backend/domain/og/renderer';
import type { OgFields, OgTemplate } from '@backend/domain/og/templates';
import type { ObjectStore } from '@backend/domain/storage/ports';

export interface OgImageDeps {
  /** Keys the signatures; derived from AUTH_SECRET in production. */
  secret: string;
  render: OgRenderer;
  /**
   * Where rendered images are kept; without one every request renders. A getter, read only
   * when an image is asked for, so issuing a path at build time needs no storage or database.
   */
  store: () => Pick<ObjectStore, 'get' | 'put'> | undefined;
}

/** Rendered images never change under their URL. */
export const OG_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** The longest `d` a URL may carry — the largest template's fields fit well within it. */
const MAX_DATA = 2048;
const SIGNATURE = /^[A-Za-z0-9_-]{32}$/u;
const DATA = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_DATA}}$`, 'u');

// Uint8Array.toBase64/fromBase64 are behind a flag on the Node this targets (see infra/crypto/secret-box.ts).
// eslint-disable-next-line unicorn/prefer-uint8array-base64
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

export class OgImageService {
  constructor(private readonly deps: OgImageDeps) {}

  private sign(template: OgTemplate, data: string): string {
    return createHmac('sha256', this.deps.secret)
      .update(`${template}@${OgTemplates[template].version}\n${data}`)
      .digest('base64url')
      .slice(0, 32);
  }

  private async render(template: OgTemplate, data: string): Promise<Uint8Array | undefined> {
    let decoded: unknown;
    try {
      // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- see encode
      decoded = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
    const size = { width: OG_WIDTH, height: OG_HEIGHT };
    // Each branch narrows the template so its builder gets its own fields' type.
    if (template === 'simple') {
      const fields = OgTemplates.simple.fields.safeParse(decoded);
      return fields.success ? await this.deps.render(OgTemplates.simple.build(fields.data), size) : undefined;
    }
    const fields = OgTemplates.article.fields.safeParse(decoded);
    return fields.success ? await this.deps.render(OgTemplates.article.build(fields.data), size) : undefined;
  }

  /** The image's path for these fields: `/og/v1/<template>/<signature>.png?d=<data>`. */
  issue<T extends OgTemplate>(template: T, fields: OgFields<T>): string {
    const data = encode(OgTemplates[template].fields.parse(fields));
    return `/og/v1/${template}/${this.sign(template, data)}.png?d=${data}`;
  }

  /** The PNG behind an issued path, or undefined (unknown template, bad signature or data). */
  async image(template: string, file: string, data: string | undefined): Promise<Uint8Array | undefined> {
    const parsedTemplate = ogTemplateSchema.safeParse(template);
    const signature = /^(?<sig>[\w-]+)\.png$/u.exec(file)?.groups?.sig ?? '';
    if (!parsedTemplate.success || !SIGNATURE.test(signature) || data === undefined || !DATA.test(data)) {
      return undefined;
    }
    const expected = Buffer.from(this.sign(parsedTemplate.data, data));
    if (!timingSafeEqual(expected, Buffer.from(signature))) {
      return undefined;
    }
    const key = `pub/og/${parsedTemplate.data}/${signature}.png`;
    const store = this.deps.store();
    const stored = await store?.get(key);
    if (stored !== null && stored !== undefined) {
      return stored;
    }
    const png = await this.render(parsedTemplate.data, data);
    if (png !== undefined && store !== undefined) {
      await store.put(key, png, {
        contentType: 'image/png',
        cacheControl: OG_CACHE_CONTROL,
        visibility: Visibilities.public,
      });
    }
    return png;
  }
}
