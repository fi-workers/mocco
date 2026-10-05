// The element tree an OG template builds (ADR 0030): the subset of a React element the
// renderer reads — a tag, inline styles and children — so templates need no JSX and no
// React. Templates use flexbox and inline styles only, which both satori and Takumi lay out.

export type OgStyle = Readonly<Record<string, string | number>>;

export interface OgElement {
  type: 'div';
  props: { style: OgStyle; children: OgChild | readonly OgChild[] };
}
export type OgChild = OgElement | string;

/** A box; every box with more than one child is a flex container (satori requires it). */
export function box(style: OgStyle, ...children: OgChild[]): OgElement {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children } };
}

/** A run of text. Lines break between words, never inside a Korean word (keep-all). */
export function text(style: OgStyle, value: string): OgElement {
  return { type: 'div', props: { style: { display: 'flex', wordBreak: 'keep-all', ...style }, children: value } };
}
