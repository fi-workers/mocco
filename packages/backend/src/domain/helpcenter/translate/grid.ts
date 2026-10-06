// The translations dashboard (#213): every published article × every offered language, as
// pure decisions over what the service read. Staleness stays derived (the source hash a
// translation was made from against the published source's), so the grid computes it per
// cell instead of reading a stored column. A help center's articles fit in memory; an
// indexed `is_stale` column can come when one doesn't.
import { TranslationFilters, TranslationStates } from '@mocco/common/help';

import type { TranslationFilter, TranslationState } from '@mocco/common/help';

export interface GridArticle {
  readonly id: string;
  readonly shortId: string;
  readonly title: string;
  readonly collection: string;
  readonly section: string;
  /** The published source's content hash. */
  readonly sourceHash: string;
}

export interface GridTranslation {
  readonly articleId: string;
  readonly locale: string;
  readonly state: TranslationState;
  readonly sourceHash: string | null;
  readonly proposalSourceHash: string | null;
  readonly proposalRevisionId: string | null;
  readonly lastError: string | null;
}

export interface GridCell {
  readonly locale: string;
  /** Null when the language has never been translated. */
  readonly state: TranslationState | null;
  readonly isStale: boolean;
  /** A machine draft for the current source waits beside a reviewed text. */
  readonly hasProposal: boolean;
  readonly lastError: string | null;
}

export interface LocaleCounts {
  readonly locale: string;
  /** Published articles. */
  readonly articles: number;
  readonly notTranslated: number;
  readonly pending: number;
  readonly translating: number;
  readonly auto: number;
  readonly reviewed: number;
  readonly failed: number;
  /** Made from an older source (any state with text). */
  readonly stale: number;
  /** Reviewed and stale, with a machine draft ready. */
  readonly proposals: number;
}

export function gridCell(article: GridArticle, locale: string, row: GridTranslation | undefined): GridCell {
  return {
    locale,
    state: row?.state ?? null,
    isStale: row?.sourceHash !== null && row?.sourceHash !== undefined && row.sourceHash !== article.sourceHash,
    hasProposal:
      row?.proposalRevisionId !== null &&
      row?.proposalRevisionId !== undefined &&
      row.proposalSourceHash === article.sourceHash,
    lastError: row?.lastError ?? null,
  };
}

/** Whether a cell is one the filter lists its article for. */
export function isListedBy(cell: GridCell, filter: TranslationFilter): boolean {
  if (filter === TranslationFilters.all) {
    return true;
  }
  if (filter === TranslationFilters.stale) {
    return cell.isStale;
  }
  const isFailed = cell.state === TranslationStates.failed;
  if (filter === TranslationFilters.failed) {
    return isFailed;
  }
  return cell.isStale || isFailed || cell.state === null;
}

const STATE_KEYS = {
  [TranslationStates.pending]: 'pending',
  [TranslationStates.translating]: 'translating',
  [TranslationStates.auto]: 'auto',
  [TranslationStates.reviewed]: 'reviewed',
  [TranslationStates.failed]: 'failed',
} as const;

/** Per-language counts over every published article. */
export function localeCounts(locale: string, cells: readonly GridCell[]): LocaleCounts {
  const counts = {
    locale,
    articles: cells.length,
    notTranslated: 0,
    pending: 0,
    translating: 0,
    auto: 0,
    reviewed: 0,
    failed: 0,
    stale: 0,
    proposals: 0,
  };
  // eslint-disable-next-line no-restricted-syntax -- a tally over the cells
  for (const cell of cells) {
    if (cell.state === null) {
      counts.notTranslated += 1;
    } else {
      counts[STATE_KEYS[cell.state]] += 1;
    }
    counts.stale += Number(cell.isStale);
    counts.proposals += Number(cell.hasProposal);
  }
  return counts;
}

/**
 * The grid: per-language counts over every published article, and the articles the filter
 * lists (in the tree's order), each with a cell per language. `locales` narrows both the
 * columns and the languages the filter looks at.
 */
export function translationGrid(
  articles: readonly GridArticle[],
  translations: readonly GridTranslation[],
  locales: readonly string[],
  filter: TranslationFilter,
) {
  const byKey = new Map(translations.map(row => [`${row.articleId}:${row.locale}`, row]));
  const rows = articles.map(article => ({
    article,
    cells: locales.map(locale => gridCell(article, locale, byKey.get(`${article.id}:${locale}`))),
  }));
  return {
    counts: locales.map((locale, i) =>
      localeCounts(
        locale,
        rows.flatMap(({ cells }) => (cells[i] === undefined ? [] : [cells[i]])),
      ),
    ),
    rows: rows.filter(({ cells }) => cells.some(cell => isListedBy(cell, filter))),
  };
}
