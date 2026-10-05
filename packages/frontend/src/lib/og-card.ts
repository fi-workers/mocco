// A page's own share card (#371): the path of a signed OG image (ADR 0030) for these fields,
// issued in getStaticProps at build time. Null when cards can't be issued (no AUTH_SECRET in
// the build), and the page falls back to Mocco's static card. Server-only: getStaticProps is
// the only caller, so the backend never reaches the browser bundle.
import { getOgImages } from '@mocco/backend/og/instance';

/** Mocco's own pages carry Mocco's name on their cards. */
const MOCCO_BRAND = { name: 'Mocco' };

/** Cut a text to a template's field limit (domain/og/templates.ts), at a word. */
function clip(value: string, max: number): string {
  // eslint-disable-next-line sonarjs/null-dereference -- a string, never null
  if (value.length <= max) {
    return value;
  }
  const cut = value.slice(0, max - 1);
  // eslint-disable-next-line sonarjs/null-dereference -- a string, never null
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A guide's card: where it sits, its title and its description. */
export function moccoArticleCard(fields: { eyebrow: string; title: string; description: string }): string | null {
  return (
    getOgImages()?.issue('article', {
      brand: MOCCO_BRAND,
      eyebrow: clip(fields.eyebrow, 60),
      title: clip(fields.title, 120),
      description: clip(fields.description, 200),
    }) ?? null
  );
}

/** A page's card with a title and a line under it. */
export function moccoSimpleCard(fields: { title: string; subtitle: string }): string | null {
  return (
    getOgImages()?.issue('simple', {
      brand: MOCCO_BRAND,
      title: clip(fields.title, 120),
      subtitle: clip(fields.subtitle, 160),
    }) ?? null
  );
}
