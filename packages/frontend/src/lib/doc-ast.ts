// The small Markdown tree the customer guide pages render. Built at build time from the
// guides (lib/customer-docs.ts) and passed as static props, so the page renders plain
// React elements: no HTML string, no Markdown library in the browser bundle.

export type DocInline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: DocInline[] }
  | { t: 'em'; c: DocInline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; external: boolean; c: DocInline[] }
  | { t: 'image'; src: string; alt: string; width: number; height: number }
  | { t: 'br' };

export type DocBlock =
  | { t: 'heading'; depth: number; id: string; c: DocInline[] }
  | { t: 'p'; c: DocInline[] }
  | { t: 'list'; ordered: boolean; start: number; items: DocBlock[][] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: DocBlock[] }
  | { t: 'table'; header: DocInline[][]; rows: DocInline[][][] }
  | { t: 'hr' };

export interface DocPage {
  slug: string;
  title: string;
  description: string;
  blocks: DocBlock[];
}

export interface DocNavEntry {
  slug: string;
  title: string;
}
