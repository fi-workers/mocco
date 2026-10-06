// The help center's Markdown parser and serializer (#211): CommonMark plus GitHub's
// tables, strikethrough, task lists, footnotes and autolinks, through unified/remark.
// segment, protect, reassemble and validate all read the same tree, so a document
// always parses the same way on both sides of a translation.
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';

import type { Root } from 'mdast';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, { bullet: '-', emphasis: '*', strong: '*', rule: '-', fences: true, listItemIndent: 'one' });

/** The mdast tree of a Markdown document. */
export function parseMarkdown(markdown: string): Root {
  return processor.parse(markdown);
}

/** A tree back to Markdown, in the one house style. */
export function stringifyMarkdown(tree: Root): string {
  return processor.stringify(tree);
}

/**
 * The document in the house style: what a reassembled translation looks like. Markers,
 * list indents and escapes are rewritten; the parsed structure and text are not.
 */
export function normalizeMarkdown(markdown: string): string {
  return stringifyMarkdown(parseMarkdown(markdown));
}
