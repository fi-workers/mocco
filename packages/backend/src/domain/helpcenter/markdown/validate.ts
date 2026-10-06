// Validation (#211): a translation may change words, never structure or where links go.
//
// - `segmentProblem` checks one translated segment against its source: every placeholder
//   exactly once, wrapping ones opened before they close and properly nested, no
//   unknown or stray ones, and no URL the source didn't have.
// - `structureProblem` checks a whole translated document against its source: the same
//   heading levels in order, byte-identical code blocks, and the same link and image
//   targets. Reassembled text passes by construction; a whole-document translation
//   (HelpTranslationService today) is checked the same way.
import { PLACEHOLDER, URL_LIKE } from '@backend/domain/helpcenter/markdown/protect';
import { parseMarkdown } from '@backend/domain/helpcenter/markdown/tree';

import type { Slot } from '@backend/domain/helpcenter/markdown/protect';
import type { Definition, Image, Link, Nodes } from 'mdast';

/* eslint-disable sonarjs/null-dereference -- every value here is a string from the parsed tree or a regex match, never null */

const urlsIn = (text: string) => Array.from(text.replaceAll(PLACEHOLDER, ' ').matchAll(URL_LIKE), match => match[0]);

interface Token {
  readonly token: string;
  readonly isClose: boolean;
  readonly n: number;
}

/** The first wrapping placeholder that closes before it opens or across another one. */
const misnested = (tokens: readonly Token[], slots: readonly Slot[]) => {
  const open: number[] = [];
  return tokens
    .filter(({ n }) => slots[n]?.type === 'wrap')
    .find(({ isClose, n }) => {
      if (!isClose) {
        open.push(n);
        return false;
      }
      return open.pop() !== n;
    });
};

function placeholderProblem(slots: readonly Slot[], translated: string): string | null {
  const tokens: Token[] = Array.from(translated.matchAll(PLACEHOLDER), match => ({
    token: match[0],
    isClose: match[1] === '/',
    n: Number(match[2]),
  }));
  const unknown = tokens.find(({ isClose, n }) => slots[n] === undefined || (isClose && slots[n]?.type !== 'wrap'));
  if (unknown !== undefined) {
    return `an unknown placeholder ${unknown.token}`;
  }
  const repeated = tokens.find(({ token }, i) => tokens.findIndex(other => other.token === token) !== i);
  if (repeated !== undefined) {
    return `the placeholder ${repeated.token} appears more than once`;
  }
  const present = new Set(tokens.map(({ token }) => token));
  const missing = slots
    .flatMap((slot, n) => (slot.type === 'wrap' ? [`⟦${String(n)}⟧`, `⟦/${String(n)}⟧`] : [`⟦${String(n)}⟧`]))
    .find(token => !present.has(token));
  if (missing !== undefined) {
    return `the placeholder ${missing} is missing`;
  }
  const outOfOrder = misnested(tokens, slots);
  if (outOfOrder !== undefined) {
    return `the placeholder ${outOfOrder.token} closes out of order`;
  }
  return /[⟦⟧]/u.test(translated.replaceAll(PLACEHOLDER, '')) ? 'a stray placeholder bracket' : null;
}

/** Why a translated segment can't be put back, or null when it can. */
export function segmentProblem(source: { text: string; slots: readonly Slot[] }, translated: string): string | null {
  const placeholders = placeholderProblem(source.slots, translated);
  if (placeholders !== null) {
    return placeholders;
  }
  const known = new Set(urlsIn(source.text));
  const added = urlsIn(translated).find(url => !known.has(url));
  return added === undefined ? null : `a new link (${added})`;
}

const descendants = (node: Nodes): Nodes[] =>
  'children' in node ? [node, ...node.children.flatMap(child => descendants(child))] : [node];

const TARGET_TYPES: readonly string[] = ['link', 'image', 'definition'] satisfies Nodes['type'][];

const shape = (markdown: string) => {
  const nodes = descendants(parseMarkdown(markdown));
  return {
    headings: nodes.flatMap(node => (node.type === 'heading' ? [String(node.depth)] : [])).join(','),
    code: nodes
      .flatMap(node => (node.type === 'code' ? [JSON.stringify([node.lang, node.meta, node.value])] : []))
      .join('\n'),
    targets: nodes
      .filter((node): node is Definition | Image | Link => TARGET_TYPES.includes(node.type))
      .map(({ url }) => url)
      .toSorted((a, b) => a.localeCompare(b))
      .join('\n'),
  };
};

/** Why the translated document changed the source's structure, or null when it kept it. */
export function structureProblem(source: string, translated: string): string | null {
  const before = shape(source);
  const after = shape(translated);
  if (before.headings !== after.headings) {
    return 'the headings changed';
  }
  if (before.code !== after.code) {
    return 'a code block changed';
  }
  if (before.targets !== after.targets) {
    return 'a link or image target changed';
  }
  return null;
}
