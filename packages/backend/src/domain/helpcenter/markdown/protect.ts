// Protection (#211): what a translator must not change is swapped for numbered
// placeholders before a segment leaves Mocco, and swapped back afterwards.
//
// - `⟦n⟧` stands for something kept whole: inline code, an image, an autolink, a hard
//   break, inline HTML, or a piece of text that is a URL (`https://…`, `asset://…`), a
//   `{{variable}}`, an emoji shortcode, a glossary keep term, or a literal `⟦`/`⟧`.
// - `⟦n⟧…⟦/n⟧` wraps text that stays translatable inside formatting the source owns:
//   emphasis, strong, strikethrough and links. A link's text is translated; its target
//   lives in the placeholder, never in the text.
//
// The translator sees only the text; the slots stay here, so what comes back can move
// placeholders around but never change what they hold.
/* eslint-disable sonarjs/null-dereference -- every value here is a string from the parsed tree or a regex match, never null */

import type { Delete, Emphasis, Link, LinkReference, PhrasingContent, Strong, Text } from 'mdast';

/** A placeholder in segment text: group 1 is `/` for a closing one, group 2 its number. */
export const PLACEHOLDER = /⟦(\/?)(\d+)⟧/gu;

/** The same, as one capture group, for `split`. */
const PLACEHOLDER_TOKEN = /(⟦\/?\d+⟧)/u;

/** Formatting whose text is translated in place. */
export type WrapNode = Delete | Emphasis | Link | LinkReference | Strong;

/** What one placeholder number holds. */
export type Slot =
  | { readonly type: 'literal'; readonly value: string }
  | { readonly type: 'node'; readonly node: PhrasingContent }
  | { readonly type: 'wrap'; readonly node: WrapNode };

/** Text for the translator, and the slots its placeholders refer to. */
export interface Protected {
  readonly text: string;
  readonly slots: readonly Slot[];
}

export interface ProtectOptions {
  /** Glossary terms kept as written (case-sensitive). */
  readonly keep?: readonly string[];
}

// A URL in text (GFM autolinks most before this, but not `asset://`) is ASCII, so one
// written flush against Korean or Japanese text ends before it; its last character
// can't be sentence punctuation, so `see asset://a.png.` keeps the period as text.
const URL_BODY = String.raw`[\w\-.~:/?#[\]@!$&'*+,;=%]*[\w/#=&~+\-]`;
const URL_SOURCES = [
  String.raw`[a-zA-Z][a-zA-Z\d+.\-]*:\/\/${URL_BODY}`,
  String.raw`www\.${URL_BODY}`,
  `mailto:${URL_BODY}`,
  String.raw`[\w.+\-]+@[a-zA-Z\d\-]+(?:\.[a-zA-Z\d\-]+)+`,
];
const VARIABLE = String.raw`\{\{[^{}\n]*\}\}`;
const EMOJI = String.raw`:[a-z][a-z\d_+\-]*:`;
const BRACKET = '[⟦⟧]';

/** Anything that reads as a link target; a translation must not add one. */
export const URL_LIKE = new RegExp(URL_SOURCES.join('|'), 'gu');

const escapeRegExp = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const protectedPattern = (keep: readonly string[]) => {
  const terms = keep
    .filter(term => term.trim() !== '')
    .toSorted((a, b) => b.length - a.length)
    .map(term => escapeRegExp(term));
  return new RegExp([...terms, ...URL_SOURCES, VARIABLE, EMOJI, BRACKET].join('|'), 'gu');
};

class SlotWriter {
  readonly #pattern: RegExp;

  readonly slots: Slot[] = [];

  constructor(options: ProtectOptions) {
    this.#pattern = protectedPattern(options.keep ?? []);
  }

  add(slot: Slot): number {
    this.slots.push(slot);
    return this.slots.length - 1;
  }

  text(value: string): string {
    return value.replaceAll(this.#pattern, match => `⟦${String(this.add({ type: 'literal', value: match }))}⟧`);
  }
}

const WRAP_TYPES: readonly string[] = [
  'emphasis',
  'strong',
  'delete',
  'linkReference',
  'link',
] satisfies WrapNode['type'][];

const isWrap = (node: PhrasingContent): node is WrapNode => WRAP_TYPES.includes(node.type);

/** `<https://a.test>`, `https://a.test`, `www.a.test` and emails: the text is the target, so it's kept whole. */
const isAutolink = (node: Link) => {
  const [only] = node.children;
  if (node.children.length !== 1 || only?.type !== 'text') {
    return false;
  }
  return [only.value, `mailto:${only.value}`, `http://${only.value}`].includes(node.url);
};

function protectNodes(nodes: readonly PhrasingContent[], writer: SlotWriter): string {
  return nodes
    .map(node => {
      if (node.type === 'text') {
        return writer.text(node.value);
      }
      if (isWrap(node) && !(node.type === 'link' && isAutolink(node))) {
        const id = String(writer.add({ type: 'wrap', node }));
        return `⟦${id}⟧${protectNodes(node.children, writer)}⟦/${id}⟧`;
      }
      return `⟦${String(writer.add({ type: 'node', node }))}⟧`;
    })
    .join('');
}

/** A block's inline content (a paragraph, heading or table cell) as translatable text. */
export function protectInline(nodes: readonly PhrasingContent[], options: ProtectOptions = {}): Protected {
  const writer = new SlotWriter(options);
  const text = protectNodes(nodes, writer);
  return { text, slots: writer.slots };
}

/** A plain string (a title, an image's alt text) as translatable text. */
export function protectPlain(value: string, options: ProtectOptions = {}): Protected {
  const writer = new SlotWriter(options);
  const text = writer.text(value);
  return { text, slots: writer.slots };
}

interface Frame {
  readonly node: WrapNode | null;
  readonly children: PhrasingContent[];
}

const pushText = (children: PhrasingContent[], value: string) => {
  if (value === '') {
    return;
  }
  const last = children.at(-1);
  if (last?.type === 'text') {
    last.value += value;
  } else {
    children.push({ type: 'text', value } satisfies Text);
  }
};

/**
 * Translated text back into inline nodes, reusing the source's own nodes for every
 * placeholder. The text must already have passed `segmentProblem` (validate.ts).
 */
export function restoreInline(text: string, slots: readonly Slot[]): PhrasingContent[] {
  const root: Frame = { node: null, children: [] };
  const stack: Frame[] = [root];
  const top = () => stack.at(-1) ?? root;
  // split() with a capture alternates text and placeholders: [text, ⟦n⟧, text, …].
  // eslint-disable-next-line no-restricted-syntax -- a stack machine over the parts, not a mapping
  for (const [i, part] of text.split(PLACEHOLDER_TOKEN).entries()) {
    const match = i % 2 === 1 ? /^⟦(\/?)(\d+)⟧$/u.exec(part) : null;
    const slot = match === null ? undefined : slots[Number(match[2])];
    if (slot === undefined) {
      pushText(top().children, part);
    } else if (slot.type === 'literal') {
      pushText(top().children, slot.value);
    } else if (slot.type === 'node') {
      top().children.push(slot.node);
    } else if (match?.[1] === '/') {
      const frame = top();
      stack.pop();
      if (frame.node !== null) {
        frame.node.children = frame.children;
        top().children.push(frame.node);
      }
    } else {
      stack.push({ node: slot.node, children: [] });
    }
  }
  return root.children;
}

/** Translated plain text back into a string. The text must already have passed `segmentProblem`. */
export function restorePlain(text: string, slots: readonly Slot[]): string {
  return text.replaceAll(PLACEHOLDER, (whole, _close: string, n: string) => {
    const slot = slots[Number(n)];
    return slot?.type === 'literal' ? slot.value : whole;
  });
}
