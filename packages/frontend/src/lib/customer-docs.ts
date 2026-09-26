// Build-time reader for the customer guides in docs/customer/notifications/ (notification
// relay design §10). Only getStaticProps / getStaticPaths call it, so node:fs and the
// Markdown lexer never reach the browser bundle. The Markdown becomes a small tree
// (lib/doc-ast.ts) that the page renders as React elements.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Lexer } from 'marked';

import { Routes } from '@frontend/lib/routes';

import type { DocBlock, DocInline, DocNavEntry, DocPage } from '@frontend/lib/doc-ast';
import type { Token, Tokens } from 'marked';

/** The guides, relative to the frontend package (the cwd of `next build` / `next dev`). */
const GUIDES_DIR = path.join(process.cwd(), '..', '..', 'docs', 'customer', 'notifications');

/** Where the build copies the guides' screenshots (scripts/copy-customer-docs-images.mjs). */
export const GUIDE_IMAGES_PATH = '/docs/notifications/images';

/** Reading order of the guides in the side nav; any other page follows alphabetically. */
const ORDER = ['overview', 'connect-discord', 'sentry', 'vercel', 'github', 'mocco-events', 'troubleshooting'];

const SLUG = /^[a-z0-9-]+$/u;
const GUIDE_FILE = /^([a-z0-9-]+)\.md$/u;

function rank(slug: string): number {
  const index = ORDER.indexOf(slug);
  return index === -1 ? ORDER.length : index;
}

function readGuide(slug: string): string {
  return readFileSync(path.join(GUIDES_DIR, `${slug}.md`), 'utf8');
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

/** GitHub-style heading anchors, so `page.md#some-heading` links keep working. */
export function slugify(text: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- a heading's text, never null
  return text
    .toLowerCase()
    .trim()
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, '')
    .replaceAll(/\s/gu, '-');
}

/** PNG width and height from the IHDR chunk (bytes 16–23). */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** A link in a guide, as the app serves it: `./x.md#a` → `/docs/notifications/x#a`. */
function resolveHref(href: string): { href: string; external: boolean } {
  if (/^(?:https?:\/\/|mailto:)/u.test(href)) {
    return { href, external: true };
  }
  // eslint-disable-next-line sonarjs/null-dereference -- a link's href, never null
  if (href.startsWith('#')) {
    return { href, external: false };
  }
  const guide = /^\.\/([a-z0-9-]+)\.md(#.*)?$/u.exec(href);
  if (guide?.[1] !== undefined) {
    return { href: `${Routes.notificationsGuide(guide[1])}${guide[2] ?? ''}`, external: false };
  }
  throw new Error(`customer guide link ${href} must be ./<page>.md, an anchor or an http(s) URL`);
}

function plainText(tokens: readonly Token[]): string {
  return tokens
    .map(token => {
      const nested = (token as Tokens.Generic).tokens;
      return nested === undefined ? (((token as Tokens.Generic).text as string | undefined) ?? '') : plainText(nested);
    })
    .join('');
}

function inline(tokens: readonly Token[]): DocInline[] {
  return tokens.flatMap((token): DocInline[] => {
    switch (token.type) {
      case 'strong': {
        return [{ t: 'strong', c: inline((token as Tokens.Strong).tokens) }];
      }
      case 'em': {
        return [{ t: 'em', c: inline((token as Tokens.Em).tokens) }];
      }
      case 'codespan': {
        return [{ t: 'code', v: (token as Tokens.Codespan).text }];
      }
      case 'br': {
        return [{ t: 'br' }];
      }
      case 'link': {
        const link = token as Tokens.Link;
        return [{ t: 'link', ...resolveHref(link.href), c: inline(link.tokens) }];
      }
      case 'image': {
        const image = token as Tokens.Image;
        const name = /^\.\/images\/([\w-]+\.png)$/u.exec(image.href)?.[1];
        if (name === undefined) {
          throw new Error(`customer guide image ${image.href} must be ./images/<name>.png`);
        }
        return [
          {
            t: 'image',
            src: `${GUIDE_IMAGES_PATH}/${name}`,
            alt: image.text,
            ...pngSize(path.join(GUIDES_DIR, 'images', name)),
          },
        ];
      }
      case 'text': {
        const text = token as Tokens.Text;
        return text.tokens === undefined ? [{ t: 'text', v: text.text }] : inline(text.tokens);
      }
      case 'escape': {
        return [{ t: 'text', v: (token as Tokens.Escape).text }];
      }
      default: {
        // html and anything else: its raw text, never markup.
        return [{ t: 'text', v: token.raw }];
      }
    }
  });
}

function blocks(tokens: readonly Token[]): DocBlock[] {
  return tokens.flatMap((token): DocBlock[] => {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        return [
          { t: 'heading', depth: heading.depth, id: slugify(plainText(heading.tokens)), c: inline(heading.tokens) },
        ];
      }
      case 'paragraph': {
        return [{ t: 'p', c: inline((token as Tokens.Paragraph).tokens) }];
      }
      case 'text': {
        // A tight list item's text.
        const text = token as Tokens.Text;
        return [{ t: 'p', c: text.tokens === undefined ? [{ t: 'text', v: text.text }] : inline(text.tokens) }];
      }
      case 'list': {
        const list = token as Tokens.List;
        return [
          {
            t: 'list',
            ordered: list.ordered,
            start: list.start === '' ? 1 : list.start,
            items: list.items.map(item => blocks(item.tokens)),
          },
        ];
      }
      case 'code': {
        const code = token as Tokens.Code;
        return [{ t: 'code', lang: code.lang ?? '', v: code.text }];
      }
      case 'blockquote': {
        return [{ t: 'quote', c: blocks((token as Tokens.Blockquote).tokens) }];
      }
      case 'table': {
        const table = token as Tokens.Table;
        return [
          {
            t: 'table',
            header: table.header.map(cell => inline(cell.tokens)),
            rows: table.rows.map(row => row.map(cell => inline(cell.tokens))),
          },
        ];
      }
      case 'hr': {
        return [{ t: 'hr' }];
      }
      default: {
        // space, html, def: nothing to render.
        return [];
      }
    }
  });
}

/** Every guide slug, in reading order. */
export function listGuideSlugs(): string[] {
  const slugs = readdirSync(GUIDES_DIR).flatMap(file => {
    const slug = GUIDE_FILE.exec(file)?.[1];
    return slug === undefined ? [] : [slug];
  });
  return slugs.toSorted((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
}

export function listGuides(): DocNavEntry[] {
  return listGuideSlugs().map(slug => ({ slug, title: splitFrontmatter(readGuide(slug)).title }));
}

/** One guide as a render tree. The page's own `# Title` is kept as its heading. */
export function readGuidePage(slug: string): DocPage {
  if (!SLUG.test(slug)) {
    throw new Error(`invalid guide slug ${slug}`);
  }
  const { title, description, body } = splitFrontmatter(readGuide(slug));
  return { slug, title, description, blocks: blocks(new Lexer({ gfm: true }).lex(body)) };
}
