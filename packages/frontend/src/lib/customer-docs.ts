// Build-time reader for the customer guides in docs/customer/<set>/ (one folder per
// product area, e.g. start, notifications, ota). Only getStaticProps / getStaticPaths call it,
// so node:fs and the Markdown lexer never reach the browser bundle. The Markdown becomes
// a small tree (lib/doc-ast.ts) that the page renders as React elements.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { GuideSets } from '@frontend/lib/guide-sets';
import { markdownToBlocks } from '@frontend/lib/markdown-blocks';
import { Routes } from '@frontend/lib/routes';

import type { DocInline, DocNavEntry, DocPage } from '@frontend/lib/doc-ast';
import type { GuideSet } from '@frontend/lib/guide-sets';

/** A set's guides, relative to the frontend package (the cwd of `next build` / `next dev`). */
const guidesDir = (set: GuideSet) => path.join(process.cwd(), '..', '..', 'docs', 'customer', set);

/** Where the build copies a set's screenshots (scripts/copy-customer-docs-images.mjs). */
const imagesPath = (set: GuideSet) => `/docs/${set}/images`;

/** Reading order of each set's guides in the side nav; any other page follows alphabetically. */
const ORDER: Record<GuideSet, readonly string[]> = {
  [GuideSets.start]: ['overview', 'workspace-and-projects', 'members-and-access', 'api-keys', 'audit-log'],
  [GuideSets.governance]: ['overview'],
  [GuideSets.notifications]: [
    'overview',
    'connect-discord',
    'sentry',
    'vercel',
    'github',
    'mocco-events',
    'troubleshooting',
  ],
  [GuideSets.ota]: ['overview', 'force-update', 'pipeline', 'gate-eas-update', 'gate-codepush', 'gate-hot-updater'],
  [GuideSets.flags]: ['quickstart'],
  [GuideSets.messenger]: ['contact-us'],
};

const SLUG = /^[a-z0-9-]+$/u;
const GUIDE_FILE = /^([a-z0-9-]+)\.md$/u;
const SETS = new Set<string>(Object.values(GuideSets));

function rank(set: GuideSet, slug: string): number {
  const index = ORDER[set].indexOf(slug);
  return index === -1 ? ORDER[set].length : index;
}

function readGuide(set: GuideSet, slug: string): string {
  return readFileSync(path.join(guidesDir(set), `${slug}.md`), 'utf8');
}

/** Split the YAML frontmatter from the body; only `title` and `description` are read. */
function splitFrontmatter(source: string): { title: string; description: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(source);
  const front = match?.[1] ?? '';
  const field = (key: string) => new RegExp(String.raw`^${key}:\s*(.*)$`, 'mu').exec(front)?.[1]?.trim() ?? '';
  // eslint-disable-next-line sonarjs/null-dereference -- a file's text, never null
  const body = source.slice(match?.[0].length ?? 0);
  return { title: field('title'), description: field('description'), body };
}

/** PNG width and height from the IHDR chunk (bytes 16–23). */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** A guide's screenshot: `./images/<name>.png`, served from the set's images path. */
function guideImage(set: GuideSet, href: string, alt: string): Extract<DocInline, { t: 'image' }> {
  const name = /^\.\/images\/([\w-]+\.png)$/u.exec(href)?.[1];
  if (name === undefined) {
    throw new Error(`customer guide image ${href} must be ./images/<name>.png`);
  }
  return { t: 'image', src: `${imagesPath(set)}/${name}`, alt, ...pngSize(path.join(guidesDir(set), 'images', name)) };
}

/** A link in a guide, as the app serves it: `./x.md#a` → `/docs/<same set>/x#a`, and
 * `../<set>/x.md#a` → `/docs/<set>/x#a`. */
function resolveHref(set: GuideSet, href: string): { href: string; external: boolean } {
  if (/^(?:https?:\/\/|mailto:)/u.test(href)) {
    return { href, external: true };
  }
  // eslint-disable-next-line sonarjs/null-dereference -- a link's href, never null
  if (href.startsWith('#')) {
    return { href, external: false };
  }
  const guide = /^\.\/([a-z0-9-]+)\.md(#.*)?$/u.exec(href);
  if (guide?.[1] !== undefined) {
    return { href: `${Routes.guide(set, guide[1])}${guide[2] ?? ''}`, external: false };
  }
  const other = /^\.\.\/([a-z0-9-]+)\/([a-z0-9-]+)\.md(#.*)?$/u.exec(href);
  if (other?.[1] !== undefined && other[2] !== undefined && SETS.has(other[1])) {
    return { href: `${Routes.guide(other[1], other[2])}${other[3] ?? ''}`, external: false };
  }
  throw new Error(`customer guide link ${href} must be ./<page>.md, ../<set>/<page>.md, an anchor or an http(s) URL`);
}

/** Every guide slug of a set, in reading order. */
export function listGuideSlugs(set: GuideSet): string[] {
  const slugs = readdirSync(guidesDir(set)).flatMap(file => {
    const slug = GUIDE_FILE.exec(file)?.[1];
    return slug === undefined ? [] : [slug];
  });
  return slugs.toSorted((a, b) => rank(set, a) - rank(set, b) || (a < b ? -1 : 1));
}

export function listGuides(set: GuideSet): DocNavEntry[] {
  return listGuideSlugs(set).map(slug => ({ slug, title: splitFrontmatter(readGuide(set, slug)).title }));
}

/** One guide as a render tree. The page's own `# Title` is kept as its heading. */
export function readGuidePage(set: GuideSet, slug: string): DocPage {
  if (!SLUG.test(slug)) {
    throw new Error(`invalid guide slug ${slug}`);
  }
  const { title, description, body } = splitFrontmatter(readGuide(set, slug));
  return {
    slug,
    title,
    description,
    blocks: markdownToBlocks(body, {
      link: href => resolveHref(set, href),
      image: (href, alt) => guideImage(set, href, alt),
    }),
  };
}
