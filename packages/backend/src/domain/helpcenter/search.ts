// Searching a help center (#96): every query term must appear in the title or the text
// (case-insensitive, any script, so Korean and Japanese work without a tokenizer);
// title hits rank first. Pure: the read service hands it the published texts. A site's
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

const MAX_TERMS = 6;
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

export function searchArticles(articles: readonly SearchableArticle[], query: string, limit: number): SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .filter(term => term !== '')
    .slice(0, MAX_TERMS);
  if (terms.length === 0) {
    return [];
  }
  return articles
    .map(article => {
      const text = plain(article.body);
      const title = article.title.toLowerCase();
      const body = text.toLowerCase();
      const isMatch = terms.every(term => title.includes(term) || body.includes(term));
      const score =
        terms.filter(term => title.includes(term)).length * 10 + terms.filter(term => body.includes(term)).length;
      const firstInBody = terms.find(term => body.includes(term)) ?? terms[0] ?? '';
      return { article, isMatch, score, snippet: snippetOf(text, firstInBody) };
    })
    .filter(entry => entry.isMatch)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => ({ title: entry.article.title, path: entry.article.path, snippet: entry.snippet }));
}
