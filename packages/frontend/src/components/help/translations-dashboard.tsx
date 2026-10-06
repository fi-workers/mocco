// The translations dashboard (#213): per language, how many published articles are machine
// translated, reviewed, stale, failed or not translated, and a grid of articles × languages
// to filter by what needs looking at. Each cell opens that language's review in the article
// editor. The filter, language and page live in the URL.
import { TranslationFilters, TranslationGridLimits } from '@mocco/common/help';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { languageName } from '@frontend/components/help/translation-review';
import { errorMessage, Spinner, StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { cn } from '@frontend/lib/utils';

import type { AppRouter } from '@mocco/backend/trpc/root';
import type { HelpLocale, TranslationFilter } from '@mocco/common/help';
import type { inferRouterOutputs } from '@trpc/server';

type Grid = inferRouterOutputs<AppRouter>['help']['translationGrid'];
type Cell = Grid['articles'][number]['languages'][number];

interface Props {
  workspaceId: string;
  projectId: string;
}

const FILTER_LABELS: Record<TranslationFilter, string> = {
  [TranslationFilters.all]: 'All articles',
  [TranslationFilters.attention]: 'Needs attention',
  [TranslationFilters.stale]: 'Source changed',
  [TranslationFilters.failed]: 'Failed',
};

const filterOf = (value: unknown): TranslationFilter =>
  Object.values(TranslationFilters).find(filter => filter === value) ?? TranslationFilters.all;

const pageOf = (value: unknown): number => {
  const page = typeof value === 'string' ? Math.trunc(Number(value)) : 1;
  return Number.isFinite(page) && page > 1 ? page : 1;
};

function CellBadges({ cell }: { cell: Cell }) {
  return (
    <span className="flex flex-wrap gap-1">
      {cell.state === null ? <StatusBadge tone={Tones.neutral}>Not translated</StatusBadge> : null}
      {cell.state === 'pending' ? <StatusBadge tone={Tones.neutral}>Waiting</StatusBadge> : null}
      {cell.state === 'translating' ? <StatusBadge tone={Tones.neutral}>Translating…</StatusBadge> : null}
      {cell.state === 'auto' ? <StatusBadge tone={Tones.ok}>Machine</StatusBadge> : null}
      {cell.state === 'reviewed' ? <StatusBadge tone={Tones.ok}>Reviewed</StatusBadge> : null}
      {cell.state === 'failed' ? <StatusBadge tone={Tones.danger}>Failed</StatusBadge> : null}
      {cell.isStale ? <StatusBadge tone={Tones.warn}>Source changed</StatusBadge> : null}
      {cell.hasProposal ? <StatusBadge tone={Tones.neutral}>Draft ready</StatusBadge> : null}
    </span>
  );
}

function Counts({ grid }: { grid: Grid }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">Translations per language</caption>
        <thead className="text-left text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th scope="col" className="px-3 py-2 font-medium">
              Language
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Reviewed
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Machine
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Source changed
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Failed
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Waiting
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Not translated
            </th>
          </tr>
        </thead>
        <tbody>
          {grid.counts.map(count => (
            <tr key={count.locale} className="border-b border-border last:border-0">
              <th scope="row" className="px-3 py-2 text-left font-medium">
                {languageName(count.locale)}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {count.reviewed} of {count.articles} reviewed
                </span>
              </th>
              <td className="px-3 py-2 text-right tabular-nums">{count.reviewed}</td>
              <td className="px-3 py-2 text-right tabular-nums">{count.auto}</td>
              <td
                className={cn(
                  'px-3 py-2 text-right tabular-nums',
                  count.stale > 0 && 'font-medium text-amber-700 dark:text-amber-400',
                )}>
                {count.stale}
              </td>
              <td
                className={cn('px-3 py-2 text-right tabular-nums', count.failed > 0 && 'font-medium text-destructive')}>
                {count.failed}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{count.pending + count.translating}</td>
              <td className="px-3 py-2 text-right tabular-nums">{count.notTranslated}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TranslationsDashboard({ workspaceId, projectId }: Props) {
  const router = useRouter();
  const filter = filterOf(router.query.filter);
  const locale = typeof router.query.locale === 'string' ? router.query.locale : undefined;
  const page = pageOf(router.query.page);
  const limit = TranslationGridLimits.pageDefault;
  const gridQuery = trpc.help.translationGrid.useQuery({
    workspaceId,
    projectId,
    filter,
    ...(locale !== undefined && { locales: [locale as HelpLocale] }),
    offset: (page - 1) * limit,
    limit,
  });
  const siteQuery = trpc.help.site.useQuery({ workspaceId, projectId });
  const view = (next: { filter?: TranslationFilter; page?: number }) =>
    Routes.projectHelpTranslations(workspaceId, projectId, {
      ...(filter !== TranslationFilters.all && { filter }),
      ...(locale !== undefined && { locale }),
      ...next,
    });

  if (gridQuery.isPending || siteQuery.isPending) {
    return <Spinner />;
  }
  if (gridQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(gridQuery.error)}</p>;
  }
  const grid = gridQuery.data;
  const offered = siteQuery.data?.site?.locales ?? [];
  if (offered.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        The help center isn&apos;t offered in other languages yet. Add languages in its settings to translate it.
      </p>
    );
  }
  const lastPage = Math.max(1, Math.ceil(grid.total / limit));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href={Routes.projectHelp(workspaceId, projectId)}
          className="text-sm text-muted-foreground hover:text-foreground">
          ← Help center
        </Link>
        <h2 className="text-lg font-semibold tracking-tight">Translations</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Every published article in each language, written in {languageName(grid.sourceLocale)}.{' '}
          {grid.isAvailable
            ? 'Mocco translates on publish; a reviewed language keeps its text and gets a machine draft when the source changes.'
            : 'Automatic translation is off for this Mocco, so each language is written by hand.'}
        </p>
      </div>
      <Counts grid={grid} />
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Filter" className="flex flex-wrap gap-1">
          {[
            TranslationFilters.all,
            TranslationFilters.attention,
            TranslationFilters.stale,
            TranslationFilters.failed,
          ].map(each => (
            <Link
              key={each}
              href={view({ filter: each, page: 1 })}
              aria-current={each === filter ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium',
                each === filter
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}>
              {FILTER_LABELS[each]}
            </Link>
          ))}
        </nav>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          Language
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
            value={locale ?? ''}
            onChange={event => {
              const next = event.target.value === '' ? undefined : event.target.value;
              fireAndForget(
                router.replace(
                  Routes.projectHelpTranslations(workspaceId, projectId, {
                    ...(filter !== TranslationFilters.all && { filter }),
                    ...(next !== undefined && { locale: next }),
                  }),
                ),
              );
            }}>
            <option value="">All languages</option>
            {offered.map(each => (
              <option key={each} value={each}>
                {languageName(each)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {grid.articles.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {filter === TranslationFilters.all
            ? 'No published articles yet.'
            : 'Nothing here: every language is up to date.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">Articles and their translations</caption>
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="px-3 py-2 font-medium">
                  Article
                </th>
                {grid.locales.map(each => (
                  <th key={each} scope="col" className="px-3 py-2 font-medium">
                    {languageName(each)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.articles.map(article => (
                <tr key={article.id} className="border-b border-border align-top last:border-0">
                  <th scope="row" className="max-w-72 px-3 py-2 text-left font-normal">
                    <Link
                      href={Routes.projectHelpArticle(workspaceId, projectId, article.id)}
                      className="font-medium hover:underline">
                      {article.title}
                    </Link>
                    <span className="block truncate text-xs text-muted-foreground">
                      {article.collection} › {article.section}
                    </span>
                  </th>
                  {article.languages.map(cell => (
                    <td key={cell.locale} className="px-3 py-2">
                      <Link
                        href={Routes.projectHelpArticle(workspaceId, projectId, article.id, cell.locale)}
                        aria-label={`Review ${article.title} in ${languageName(cell.locale)}`}
                        className="block rounded-md p-1 hover:bg-muted"
                        title={cell.lastError ?? undefined}>
                        <CellBadges cell={cell} />
                      </Link>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {lastPage > 1 ? (
        <nav aria-label="Pages" className="flex items-center gap-3 text-sm">
          {page > 1 ? <Link href={view({ page: page - 1 })}>← Previous</Link> : null}
          <span className="text-muted-foreground">
            Page {page} of {lastPage} · {grid.total} articles
          </span>
          {grid.nextOffset === null ? null : <Link href={view({ page: page + 1 })}>Next →</Link>}
        </nav>
      ) : null}
    </div>
  );
}
