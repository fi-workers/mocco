// The glossary in the translation pipeline (#214), as pure functions.
//
// - A `keep` term is protected like code (markdown/protect.ts): the translator sees a
//   placeholder, and the placeholder check refuses an answer that drops it, so the term
//   comes back as written in every language. Kept terms match as written (case-sensitive).
// - A `fixed` term is sent to the translator with its translation into the target
//   language, and an answer for a segment containing the term (in any case) that doesn't
//   use that translation is refused (`fixedProblem`).
//
// What a glossary edit re-translates follows from two hashes. A segment's translation
// memory key (`memoryKey`) is its protected text's hash, plus the fixed terms in it:
// adding a kept term changes the protected text, and changing a fixed term changes the
// key, so only segments containing a changed term miss memory. An article's glossary hash
// in a language (`articleGlossaryHash`) covers the terms that apply to it there; a
// translation made under another one is translated again, sending only those misses.
/* eslint-disable sonarjs/null-dereference -- every value here is a string from a term or a segment, never null */
import { createHash } from 'node:crypto';

import { GlossaryRules } from '@mocco/common/help';

import type { Segment } from '@backend/domain/helpcenter/markdown/segment';
import type { GlossaryRule } from '@mocco/common/help';

/** A glossary term as the pipeline reads it. */
export interface GlossaryTerm {
  readonly term: string;
  readonly rule: GlossaryRule;
  readonly translations: Readonly<Partial<Record<string, string>>>;
}

/** A fixed term and its translation into one language. */
export interface FixedTerm {
  readonly term: string;
  readonly target: string;
}

/** What runs into one language follow: the kept terms, and the fixed terms translated into it. */
export interface LocaleGlossary {
  readonly keep: readonly string[];
  readonly fixed: readonly FixedTerm[];
}

export const EMPTY_GLOSSARY: LocaleGlossary = { keep: [], fixed: [] };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The glossary for `locale`: every kept term, and the fixed terms with a translation into it. */
export function glossaryFor(terms: readonly GlossaryTerm[], locale: string): LocaleGlossary {
  return {
    keep: terms.filter(({ rule }) => rule === GlossaryRules.keep).map(({ term }) => term),
    fixed: terms.flatMap(({ term, rule, translations }) => {
      const target = translations[locale];
      return rule === GlossaryRules.fixed && target !== undefined ? [{ term, target }] : [];
    }),
  };
}

/** The site's glossary hash: every term with its rule and translations; '' while there are none. */
export function siteGlossaryHash(terms: readonly GlossaryTerm[]): string {
  if (terms.length === 0) {
    return '';
  }
  const canonical = terms
    .map(({ term, rule, translations }) =>
      JSON.stringify([term, rule, Object.entries(translations).toSorted(([a], [b]) => a.localeCompare(b))]),
    )
    .toSorted((a, b) => a.localeCompare(b));
  return sha256(canonical.join('\n'));
}

const hasFixed = (text: string, term: string) => text.toLowerCase().includes(term.toLowerCase());

/** The fixed terms a segment's text contains (outside placeholders), in any case. */
export function fixedIn(glossary: LocaleGlossary, text: string): FixedTerm[] {
  return glossary.fixed.filter(({ term }) => hasFixed(text, term));
}

/** The rules that apply to these texts, one canonical line each, sorted. */
function rulesIn(glossary: LocaleGlossary, texts: readonly string[]): string[] {
  const kept = glossary.keep
    .filter(term => texts.some(text => text.includes(term)))
    .map(term => `${GlossaryRules.keep}\t${term}`);
  const fixed = glossary.fixed
    .filter(({ term }) => texts.some(text => hasFixed(text, term)))
    .map(({ term, target }) => `${GlossaryRules.fixed}\t${term.toLowerCase()}\t${target}`);
  return [...kept, ...fixed].toSorted((a, b) => a.localeCompare(b));
}

/**
 * The hash of the glossary rules that apply to an article in a language, over its
 * segments made without the glossary (so code, URLs and other placeholders don't count);
 * '' when none applies, so a glossary that never mentions the article leaves it alone.
 */
export function articleGlossaryHash(glossary: LocaleGlossary, segments: readonly Pick<Segment, 'text'>[]): string {
  const rules = rulesIn(
    glossary,
    segments.map(({ text }) => text),
  );
  return rules.length === 0 ? '' : sha256(rules.join('\n'));
}

/** A segment's translation memory key: its hash, plus the fixed terms in it with their translations. */
export function memoryKey(segment: Pick<Segment, 'hash' | 'text'>, glossary: LocaleGlossary): string {
  const fixed = fixedIn(glossary, segment.text);
  if (fixed.length === 0) {
    return segment.hash;
  }
  const rules = fixed
    .map(({ term, target }) => `${term.toLowerCase()}\t${target}`)
    .toSorted((a, b) => a.localeCompare(b));
  return sha256([segment.hash, ...rules].join('\n'));
}

/** The segments with their translation memory keys as their hashes. */
export function keyedSegments<T extends Pick<Segment, 'hash' | 'text'>>(
  segments: readonly T[],
  glossary: LocaleGlossary,
): T[] {
  return segments.map(segment => ({ ...segment, hash: memoryKey(segment, glossary) }));
}

/** Why a translated segment breaks a fixed term it contains, or null when it uses each one's translation. */
export function fixedProblem(
  source: Pick<Segment, 'text'>,
  translated: string,
  glossary: LocaleGlossary,
): string | null {
  const missing = fixedIn(glossary, source.text).find(({ target }) => !translated.includes(target));
  return missing === undefined ? null : `the glossary term "${missing.term}" must be translated as "${missing.target}"`;
}
