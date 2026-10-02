// Searching a help center (#96): by default every query term must appear in the title or
// the text (case-insensitive, any script, so Korean and Japanese work without a
// tokenizer); title hits rank first. `any` mode is for free text, such as an inquiry
// being written: an article needs one matching term, and more matching terms rank higher. Pure: the read service hands it the published texts. A site's
// help fits in memory at this scale; a Postgres index can replace this later.

/* eslint-disable sonarjs/null-dereference -- every value here is a string, never null */

export interface SearchableArticle {
  title: string;
  body: string;
  path: string;
}

export interface SearchHit {
  title: string;
  path: string;
  /** About 140 characters of the text around the first match, Markdown stripped. */
  snippet: string;
}

export type SearchMatch = 'all' | 'any';

const MAX_TERMS = { all: 6, any: 24 } as const;
const SNIPPET = 140;

/** Markdown → plain text, near enough for a snippet. */
function plain(markdown: string): string {
  // Drop fenced code: the odd pieces between ``` markers.
  const prose = markdown
    .split('```')
    .filter((_piece, index) => index % 2 === 0)
    .join(' ');
  return (
    prose
      .replaceAll(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
      // A link keeps its text: drop the target, then the brackets.
      .replaceAll(/\]\([^)]*\)/gu, ']')
      .replaceAll(/[#>*_`|[\]]/gu, ' ')
      .replaceAll(/\s+/gu, ' ')
      .trim()
  );
}

function snippetOf(text: string, term: string): string {
  const at = Math.max(0, text.toLowerCase().indexOf(term) - 40);
  const slice = text.slice(at, at + SNIPPET).trim();
  return `${at > 0 ? '…' : ''}${slice}${at + SNIPPET < text.length ? '…' : ''}`;
}

/**
 * The forms of a term to look for. In free text a Korean word usually carries a particle
 * ("위젯이", "위젯을"), so a word of three or more letters also matches without its last
 * letter. Strip trailing punctuation first.
 */
function formsOf(term: string, match: SearchMatch): string[] {
  let word = term;
  while (/[\p{P}\p{S}]$/u.test(word)) {
    word = word.slice(0, -1);
  }
  if (match === 'all') {
    return [term];
  }
  return [...word].length >= 3 ? [word, [...word].slice(0, -1).join('')] : [word];
}

export function searchArticles(
  articles: readonly SearchableArticle[],
  query: string,
  limit: number,
  match: SearchMatch = 'all',
): SearchHit[] {
  const words = query
    .toLowerCase()
    .split(/\s+/u)
    .filter(term => term !== '');
  // A one-letter word in free text ("a", "안") matches almost everything.
  const terms = (match === 'any' ? words.filter(word => [...word].length >= 2) : words).slice(0, MAX_TERMS[match]);
  if (terms.length === 0) {
    return [];
  }
  return articles
    .map(article => {
      const text = plain(article.body);
      const title = article.title.toLowerCase();
      const body = text.toLowerCase();
      const forms = terms.map(term => formsOf(term, match));
      const inTitle = forms.filter(alternatives => alternatives.some(form => title.includes(form)));
      const inBody = forms.filter(alternatives => alternatives.some(form => body.includes(form)));
      const hits = forms.filter(alternatives => alternatives.some(form => title.includes(form) || body.includes(form)));
      const isMatch = match === 'all' ? hits.length === terms.length : hits.length > 0;
      const score = hits.length * 100 + inTitle.length * 10 + inBody.length;
      const firstInBody = inBody[0]?.find(form => body.includes(form)) ?? terms[0] ?? '';
      return { article, isMatch, score, snippet: snippetOf(text, firstInBody) };
    })
    .filter(entry => entry.isMatch)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => ({ title: entry.article.title, path: entry.article.path, snippet: entry.snippet }));
}
