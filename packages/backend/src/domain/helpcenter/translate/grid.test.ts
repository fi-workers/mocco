import { TranslationFilters } from '@mocco/common/help';
import { describe, expect, it } from 'vitest';

import { translationGrid } from '@backend/domain/helpcenter/translate/grid';

import type { GridArticle, GridTranslation } from '@backend/domain/helpcenter/translate/grid';

const article = (id: string): GridArticle => ({
  id,
  shortId: id,
  title: id,
  collection: 'C',
  section: 'S',
  sourceHash: `h-${id}`,
});

const row = (articleId: string, locale: string, values: Partial<GridTranslation>): GridTranslation => ({
  articleId,
  locale,
  state: 'auto',
  sourceHash: `h-${articleId}`,
  proposalSourceHash: null,
  proposalRevisionId: null,
  lastError: null,
  ...values,
});

// a: ko auto (fresh), ja reviewed and stale with a draft for the current source.
// b: ko failed, ja not translated.  c: ko auto stale (a run will catch up), ja pending.
const ARTICLES = [article('a'), article('b'), article('c')];
const ROWS = [
  row('a', 'ko', {}),
  row('a', 'ja', { state: 'reviewed', sourceHash: 'old', proposalRevisionId: 'p', proposalSourceHash: 'h-a' }),
  row('b', 'ko', { state: 'failed', sourceHash: null, lastError: 'refused' }),
  row('c', 'ko', { sourceHash: 'old' }),
  row('c', 'ja', { state: 'pending', sourceHash: null }),
];
const ids = (grid: ReturnType<typeof translationGrid>) => grid.rows.map(({ article: each }) => each.id);

describe('translation grid', () => {
  it('counts every published article per language', () => {
    const { counts } = translationGrid(ARTICLES, ROWS, ['ko', 'ja'], TranslationFilters.all);

    expect(counts).toEqual([
      {
        locale: 'ko',
        articles: 3,
        notTranslated: 0,
        pending: 0,
        translating: 0,
        auto: 2,
        reviewed: 0,
        failed: 1,
        stale: 1,
        proposals: 0,
      },
      {
        locale: 'ja',
        articles: 3,
        notTranslated: 1,
        pending: 1,
        translating: 0,
        auto: 0,
        reviewed: 1,
        failed: 0,
        stale: 1,
        proposals: 1,
      },
    ]);
  });

  it('lists by filter, in the articles’ order', () => {
    const grid = (filter: (typeof TranslationFilters)[keyof typeof TranslationFilters], locales = ['ko', 'ja']) =>
      ids(translationGrid(ARTICLES, ROWS, locales, filter));

    expect(grid(TranslationFilters.all)).toEqual(['a', 'b', 'c']);
    expect(grid(TranslationFilters.stale)).toEqual(['a', 'c']);
    expect(grid(TranslationFilters.failed)).toEqual(['b']);
    expect(grid(TranslationFilters.attention)).toEqual(['a', 'b', 'c']);
    // Narrowed to Japanese: only its cells count for the filter.
    expect(grid(TranslationFilters.stale, ['ja'])).toEqual(['a']);
    expect(grid(TranslationFilters.attention, ['ja'])).toEqual(['a', 'b']);
  });

  it('shows a draft only when it follows the current source', () => {
    const outdated = [
      row('a', 'ja', { state: 'reviewed', sourceHash: 'old', proposalRevisionId: 'p', proposalSourceHash: 'older' }),
    ];
    const [cell] = translationGrid([article('a')], outdated, ['ja'], TranslationFilters.all).rows[0]?.cells ?? [];

    expect(cell).toEqual({ locale: 'ja', state: 'reviewed', isStale: true, hasProposal: false, lastError: null });
  });
});
