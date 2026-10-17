// The help article editor's Markdown (#486): which Tiptap nodes and marks it edits, and how its
// text goes back to Markdown. Articles are stored as Markdown, and everything that reads them
// (translation segments, the public renderer, `.md` and llms.txt pages) reads that Markdown, so
// the editor only offers what Markdown can hold: no underline, color, highlight or alignment.
//
// Tiptap's serializer escapes every `[`, `]` and writes `>` and `<` as HTML entities. The text
// then reads `&gt;` in the stored Markdown and on the `.md` pages, though nothing needed escaping.
// `encodeMarkdownText` escapes only what would otherwise change the meaning.
import { getSchema } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { MarkdownManager } from '@tiptap/markdown';
import { Node } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';

import type { AnyExtension } from '@tiptap/core';

/** StarterKit as a help article uses it. Markdown has no underline. */
export const helpStarterKitOptions = {
  underline: false,
  link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
} as const;

/** Images and tables, beside StarterKit. */
export const helpMediaExtensions: AnyExtension[] = [
  Image.configure({ inline: false }),
  TableKit.configure({ table: { resizable: false } }),
];

/** The nodes and marks of a help article, without the editor's UI (slash commands, placeholder). */
export const helpMarkdownExtensions: AnyExtension[] = [
  StarterKit.configure(helpStarterKitOptions),
  ...helpMediaExtensions,
];

/** Escape a `[...]` (on one line) that a `(`, `[` or `:` follows: it would become a link, a reference or a definition. */
function escapeLinkBrackets(text: string): string {
  /* eslint-disable sonarjs/null-dereference -- text and its slices are strings, never null */
  let out = '';
  let at = 0;
  for (let open = text.indexOf('[', at); open !== -1; open = text.indexOf('[', at)) {
    const close = text.indexOf(']', open + 1);
    const lineEnd = text.indexOf('\n', open + 1);
    if (close === -1 || (lineEnd !== -1 && lineEnd < close)) {
      break;
    }
    const isLinkLike = '([:'.includes(text.charAt(close + 1)) && text.charAt(close + 1) !== '';
    const inner = text.slice(open + 1, close);
    const bracketed = isLinkLike ? String.raw`\[${inner}\]` : `[${inner}]`;
    out += text.slice(at, open) + bracketed;
    at = close + 1;
  }
  return out + text.slice(at);
  /* eslint-enable sonarjs/null-dereference */
}

/**
 * A text node's characters as Markdown: inline syntax characters (`*`, `_`, `` ` ``, `~`, `\`)
 * are escaped, brackets only where they would start a link or image (`[x](`, `[x][`, `[x]:`),
 * `<` and an `&` that starts an entity are written as entities, and `>` only at the start of a
 * line, where it would start a quote.
 */
export function encodeMarkdownText(text: string): string {
  /* eslint-disable sonarjs/null-dereference -- text and its pieces are strings, never null */
  const escaped = text
    .replaceAll(/&(?=#?\w+;)/gu, '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll(/([\\`*_~])/gu, String.raw`\$1`);
  return escapeLinkBrackets(escaped).replaceAll(/^>/gmu, '&gt;');
  /* eslint-enable sonarjs/null-dereference */
}

interface TextEncoder {
  encodeTextForMarkdown: (
    text: string,
    node: { marks?: { type: string }[] },
    parentNode?: { type?: string } | null,
  ) => string;
  codeTypes: Set<string>;
}

/** Use `encodeMarkdownText` for the manager's plain text; code keeps its characters as they are. */
export function withLeanTextEncoding(manager: MarkdownManager): MarkdownManager {
  // The manager's text encoder is private in its types; replacing it on the instance is the only
  // hook, and `codeTypes` is the set it uses to recognize code (kept from the original).
  const encoder = manager as unknown as TextEncoder;
  encoder.encodeTextForMarkdown = (text, node, parentNode) => {
    const isCode =
      (parentNode?.type !== undefined && encoder.codeTypes.has(parentNode.type)) ||
      (node.marks ?? []).some(mark => encoder.codeTypes.has(mark.type));
    return isCode ? text : encodeMarkdownText(text);
  };
  return manager;
}

/**
 * The Markdown an article becomes when the editor opens it and saves it unchanged: parsed into
 * the editor's schema and written back. Used to check that a round trip keeps an article's
 * meaning (and so its translation segments).
 */
export function roundTripHelpMarkdown(markdown: string): string {
  const manager = withLeanTextEncoding(new MarkdownManager({ extensions: helpMarkdownExtensions }));
  const schema = getSchema(helpMarkdownExtensions);
  const document = Node.fromJSON(schema, manager.parse(markdown));
  return manager.serialize(document.toJSON());
}
