// Segmentation (#211): an article's Markdown as the ordered pieces of text a translator
// sees. Headings, paragraphs (in lists, quotes and footnotes too) and table cells are a
// segment each, with their inline content protected (protect.ts); image alt texts and
// link titles are segments of their own. Code blocks, HTML, front matter and math are
// opaque: nothing in them is ever sent. A segment's hash names its text for translation
// memory, so an edit re-translates only the segments it changed.
/* eslint-disable no-param-reassign -- a segment's apply writes its translation into the freshly parsed source tree; that is reassembly */
import { createHash } from 'node:crypto';

import { SegmentKinds } from '@mocco/common/help';

import { protectInline, protectPlain, restoreInline, restorePlain } from '@backend/domain/helpcenter/markdown/protect';
import { parseMarkdown } from '@backend/domain/helpcenter/markdown/tree';

import type { ProtectOptions, Slot } from '@backend/domain/helpcenter/markdown/protect';
import type { SegmentKind, SegmentRef } from '@mocco/common/help';
import type {
  Definition,
  Heading,
  Image,
  ImageReference,
  Link,
  Nodes,
  Paragraph,
  PhrasingContent,
  Root,
  TableCell,
} from 'mdast';

/** One piece of translatable text. Only `id` and `text` go to a translator. */
export interface Segment {
  /** Its place in the document (`s0`, `s1`, … in order; `title` for the title). */
  readonly id: string;
  readonly kind: SegmentKind;
  /** The text with placeholders (protect.ts). */
  readonly text: string;
  /** sha256 of the text with whitespace collapsed: the translation memory key. */
  readonly hash: string;
  /** What each placeholder holds; never sent. */
  readonly slots: readonly Slot[];
}

/** A segment with the write that puts its translation back into the tree (reassemble.ts). */
export interface LocatedSegment {
  readonly segment: Segment;
  /** Puts validated translated text (see `segmentProblem`) in place of the source's. */
  readonly apply: (text: string) => void;
}

export const TITLE_SEGMENT_ID = 'title';

/** sha256 of the text, Unicode-normalized and with whitespace collapsed. */
export function segmentHash(text: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- text is a string, never null
  const normalized = text.normalize('NFC').replaceAll(/\s+/gu, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/** Worth sending: there's a letter in it once the placeholders are gone (not just `⟦0⟧` or `2026`). */
// eslint-disable-next-line sonarjs/null-dereference -- text is a string, never null
const hasWords = (text: string) => /\p{L}/u.test(text.replaceAll(/⟦\/?\d+⟧/gu, ''));

type Block = Heading | Paragraph | TableCell;

const BLOCK_KINDS = {
  heading: SegmentKinds.heading,
  paragraph: SegmentKinds.paragraph,
  tableCell: SegmentKinds.tableCell,
};

/** Nodes never descended into: nothing in them is translatable or may be touched. */
const OPAQUE = new Set(['code', 'html', 'yaml', 'math', 'inlineMath', 'thematicBreak', 'inlineCode', 'break']);

const phrasingDescendants = (nodes: readonly PhrasingContent[]): PhrasingContent[] =>
  nodes.flatMap(node => ('children' in node ? [node, ...phrasingDescendants(node.children)] : [node]));

const ATTRIBUTE_TYPES: readonly string[] = ['image', 'imageReference', 'link'] satisfies (
  Image | ImageReference | Link
)['type'][];
const BLOCK_TYPES: readonly string[] = Object.keys(BLOCK_KINDS);
const isBlock = (node: Nodes): node is Block => BLOCK_TYPES.includes(node.type);

class Locator {
  readonly located: LocatedSegment[] = [];

  constructor(private readonly options: ProtectOptions) {}

  #push(kind: SegmentKind, text: string, slots: readonly Slot[], apply: LocatedSegment['apply']) {
    if (!hasWords(text)) {
      return;
    }
    const id = `s${String(this.located.length)}`;
    this.located.push({ segment: { id, kind, text, hash: segmentHash(text), slots }, apply });
  }

  #plain(kind: SegmentKind, value: string | null | undefined, write: (value: string) => void) {
    if (value === undefined || value === null) {
      return;
    }
    const { text, slots } = protectPlain(value, this.options);
    this.#push(kind, text, slots, translated => {
      write(restorePlain(translated, slots));
    });
  }

  #attributes(node: Definition | Image | ImageReference | Link) {
    if (node.type === 'image' || node.type === 'imageReference') {
      this.#plain(SegmentKinds.imageAlt, node.alt, value => {
        node.alt = value;
      });
    }
    if (node.type !== 'imageReference') {
      this.#plain(SegmentKinds.linkTitle, node.title, value => {
        node.title = value;
      });
    }
  }

  #block(node: Block) {
    // Read the attributes now: the block's apply reuses these same node objects.
    const attributes = phrasingDescendants(node.children).filter((child): child is Image | ImageReference | Link =>
      ATTRIBUTE_TYPES.includes(child.type),
    );
    const { text, slots } = protectInline(node.children, this.options);
    this.#push(BLOCK_KINDS[node.type], text, slots, translated => {
      node.children = restoreInline(translated, slots);
    });
    // eslint-disable-next-line no-restricted-syntax -- each attribute adds segments in order, a side effect
    for (const child of attributes) {
      this.#attributes(child);
    }
  }

  walk(node: Nodes) {
    if (isBlock(node)) {
      this.#block(node);
      return;
    }
    if (node.type === 'definition') {
      this.#attributes(node);
      return;
    }
    if (OPAQUE.has(node.type) || !('children' in node)) {
      return;
    }
    // eslint-disable-next-line no-restricted-syntax -- the walk adds segments in document order, a side effect
    for (const child of node.children) {
      this.walk(child);
    }
  }
}

/** Every segment of a parsed document, in order, with where its translation goes. */
export function locateSegments(tree: Root, options: ProtectOptions = {}): LocatedSegment[] {
  const locator = new Locator(options);
  locator.walk(tree);
  return locator.located;
}

/** An article body's segments, in document order. */
export function segmentMarkdown(markdown: string, options: ProtectOptions = {}): Segment[] {
  return locateSegments(parseMarkdown(markdown), options).map(({ segment }) => segment);
}

/** An article title as one segment (titles are plain text, never Markdown). */
export function segmentTitle(title: string, options: ProtectOptions = {}): Segment {
  const { text, slots } = protectPlain(title, options);
  return { id: TITLE_SEGMENT_ID, kind: SegmentKinds.title, text, hash: segmentHash(text), slots };
}

/** The hashes a revision stores: its title, then each body segment. */
export function segmentRefsOf(title: string, body: string, options: ProtectOptions = {}): SegmentRef[] {
  return [segmentTitle(title, options), ...segmentMarkdown(body, options)].map(({ hash, kind }) => ({ hash, kind }));
}

/** The only part of segments a translator receives. */
export function translatable(segments: readonly Segment[]): { id: string; text: string }[] {
  return segments.map(({ id, text }) => ({ id, text }));
}
