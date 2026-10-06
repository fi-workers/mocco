// A help center's glossary (#214): terms every translation keeps as written (product names,
// UI labels), and terms translated one fixed way per language. A change re-translates only
// the sentences that contain the term; a reviewed language gets a machine draft instead.
// A CSV is read in the browser and sent as one import.
import { GlossaryRules, HELP_LOCALES } from '@mocco/common/help';
import { glossaryCsv, parseGlossaryCsv } from '@mocco/common/help-glossary-csv';
import Link from 'next/link';
import { useState } from 'react';

import { languageName } from '@frontend/components/help/translation-review';
import {
  errorMessage,
  inputClass,
  labelClass,
  Notice,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { AppRouter } from '@mocco/backend/trpc/root';
import type { GlossaryRule, GlossaryTermInput, HelpLocale } from '@mocco/common/help';
import type { GlossaryCsv } from '@mocco/common/help-glossary-csv';
import type { inferRouterOutputs } from '@trpc/server';

type Term = inferRouterOutputs<AppRouter>['help']['glossary']['terms'][number];

interface Props {
  workspaceId: string;
  projectId: string;
}

interface Draft {
  term: string;
  rule: GlossaryRule;
  translations: Partial<Record<HelpLocale, string>>;
  note: string;
}

const EMPTY: Draft = { term: '', rule: GlossaryRules.keep, translations: {}, note: '' };

const draftOf = (term: Term): Draft => ({
  term: term.term,
  rule: term.rule,
  translations: { ...term.translations },
  note: term.note,
});

/** The draft as the API takes it: a kept term has no translations, and empty ones are dropped. */
const inputOf = (draft: Draft): GlossaryTermInput => ({
  term: draft.term,
  rule: draft.rule,
  translations:
    draft.rule === GlossaryRules.keep
      ? {}
      : Object.fromEntries(Object.entries(draft.translations).filter(([, value]) => Boolean(value?.trim()))),
  note: draft.note,
});

function TermForm({
  locales,
  initial,
  label,
  isPending,
  onSubmit,
  onCancel,
}: {
  locales: readonly HelpLocale[];
  initial: Draft;
  label: string;
  isPending: boolean;
  onSubmit: (draft: Draft) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const set = (next: Partial<Draft>) => {
    setDraft(current => ({ ...current, ...next }));
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={event => {
        event.preventDefault();
        onSubmit(draft);
      }}>
      <div className="flex flex-wrap items-end gap-3">
        <label className={labelClass}>
          Term
          <input
            className={inputClass}
            value={draft.term}
            maxLength={100}
            required
            onChange={event => {
              set({ term: event.target.value });
            }}
          />
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-medium text-muted-foreground">Rule</legend>
          <div className="flex h-8 items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={draft.rule === GlossaryRules.keep}
                onChange={() => {
                  set({ rule: GlossaryRules.keep });
                }}
              />
              Keep as written
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={draft.rule === GlossaryRules.fixed}
                onChange={() => {
                  set({ rule: GlossaryRules.fixed });
                }}
              />
              Fixed translation
            </label>
          </div>
        </fieldset>
        <label className={`${labelClass} min-w-48 flex-1`}>
          Note
          <input
            className={inputClass}
            value={draft.note}
            maxLength={500}
            placeholder="Why, for whoever edits this next"
            onChange={event => {
              set({ note: event.target.value });
            }}
          />
        </label>
      </div>
      {draft.rule === GlossaryRules.fixed ? (
        <div className="flex flex-wrap gap-3">
          {locales.map(locale => (
            <label key={locale} className={labelClass}>
              {languageName(locale)}
              <input
                className={inputClass}
                value={draft.translations[locale] ?? ''}
                maxLength={200}
                onChange={event => {
                  set({ translations: { ...draft.translations, [locale]: event.target.value } });
                }}
              />
            </label>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="outline" className="w-fit" disabled={isPending} pending={isPending}>
          {label}
        </Button>
        {onCancel === undefined ? null : (
          <Button type="button" variant="ghost" className="w-fit" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function TermRow({
  term,
  locales,
  workspaceId,
  projectId,
}: {
  term: Term;
  locales: readonly HelpLocale[];
  workspaceId: string;
  projectId: string;
}) {
  const utils = trpc.useUtils();
  const [isEditing, setIsEditing] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const refresh = async () => {
    await utils.help.glossary.invalidate({ workspaceId, projectId });
  };
  const update = trpc.help.updateGlossaryTerm.useMutation({
    onSuccess: async () => {
      setIsEditing(false);
      await refresh();
    },
  });
  const remove = trpc.help.removeGlossaryTerm.useMutation({ onSuccess: refresh });
  const error = update.error ?? remove.error;

  if (isEditing) {
    return (
      <li className="flex flex-col gap-2 p-3">
        <TermForm
          locales={locales}
          initial={draftOf(term)}
          label="Save"
          isPending={update.isPending}
          onSubmit={draft => {
            update.mutate({ workspaceId, projectId, termId: term.id, term: inputOf(draft) });
          }}
          onCancel={() => {
            setIsEditing(false);
          }}
        />
        {error ? <p className="text-sm text-destructive">{errorMessage(error)}</p> : null}
      </li>
    );
  }
  const translated = Object.entries(term.translations);
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-1 p-3">
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{term.term}</span>
          {term.rule === GlossaryRules.keep ? (
            <StatusBadge tone={Tones.neutral}>Kept as written</StatusBadge>
          ) : (
            <StatusBadge tone={Tones.ok}>Fixed translation</StatusBadge>
          )}
        </span>
        {translated.length > 0 ? (
          <span className="text-sm text-muted-foreground">
            {translated.map(([locale, value]) => `${languageName(locale)}: ${value ?? ''}`).join(' · ')}
          </span>
        ) : null}
        {term.note === '' ? null : <span className="text-xs text-muted-foreground">{term.note}</span>}
        {error ? <span className="text-sm text-destructive">{errorMessage(error)}</span> : null}
      </div>
      <div className="flex gap-1">
        {isRemoving ? (
          <>
            <Button
              variant="destructive"
              size="sm"
              disabled={remove.isPending}
              pending={remove.isPending}
              onClick={() => {
                remove.mutate({ workspaceId, projectId, termId: term.id });
              }}>
              Remove {term.term}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsRemoving(false);
              }}>
              Keep
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsEditing(true);
              }}>
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsRemoving(true);
              }}>
              Remove
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/** `1 term`, `3 terms`. */
const counted = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`;

function CsvPreview({
  parsed,
  isPending,
  onImport,
}: {
  parsed: GlossaryCsv & { name: string };
  isPending: boolean;
  onImport: () => void;
}) {
  const unread =
    parsed.problems.length > 0 ? `, ${counted(parsed.problems.length, "row can't", "rows can't")} be read` : '';
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        {`${parsed.name}: ${counted(parsed.terms.length, 'term', 'terms')} to import${unread}.`}
      </p>
      {parsed.problems.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-destructive">
          {parsed.problems.slice(0, 10).map(problem => (
            <li key={`${String(problem.line)}:${problem.message}`}>
              {problem.line > 0 ? `Line ${String(problem.line)}: ` : ''}
              {problem.message}
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        variant="outline"
        className="w-fit"
        disabled={parsed.terms.length === 0 || isPending}
        pending={isPending}
        onClick={onImport}>
        Import {counted(parsed.terms.length, 'term', 'terms')}
      </Button>
    </div>
  );
}

function CsvImport({ workspaceId, projectId, terms }: Props & { terms: readonly Term[] }) {
  const utils = trpc.useUtils();
  const [parsed, setParsed] = useState<(GlossaryCsv & { name: string }) | null>(null);
  const importTerms = trpc.help.importGlossary.useMutation({
    onSuccess: async () => {
      setParsed(null);
      await utils.help.glossary.invalidate({ workspaceId, projectId });
    },
  });
  const readCsv = async (file: File) => {
    try {
      setParsed({ ...parseGlossaryCsv(await file.text()), name: file.name });
    } catch (error: unknown) {
      setParsed({
        name: file.name,
        terms: [],
        problems: [{ line: 0, message: error instanceof Error ? error.message : String(error) }],
      });
    }
  };
  const download = `data:text/csv;charset=utf-8,${encodeURIComponent(glossaryCsv(terms))}`;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Import from CSV</h3>
        <p className="max-w-prose text-sm text-muted-foreground">
          The first row names the columns: <code>term</code>, <code>rule</code> (<code>keep</code> or <code>fixed</code>
          ; left empty, a row with a translation is fixed), <code>note</code>, and a language code per translation (
          <code>de</code>, <code>ko</code>, …). A term already in the glossary is updated, in any case; terms not in the
          file stay.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className={labelClass} htmlFor="help-glossary-csv">
          CSV file
          <input
            id="help-glossary-csv"
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={event => {
              const file = event.target.files?.[0];
              importTerms.reset();
              if (file === undefined) {
                setParsed(null);
                return;
              }
              fireAndForget(readCsv(file));
            }}
          />
        </label>
        {terms.length > 0 ? (
          <a href={download} download="glossary.csv" className="text-sm text-foreground underline underline-offset-2">
            Download the glossary as CSV
          </a>
        ) : null}
      </div>
      {parsed === null ? null : (
        <CsvPreview
          parsed={parsed}
          isPending={importTerms.isPending}
          onImport={() => {
            importTerms.mutate({ workspaceId, projectId, terms: parsed.terms });
          }}
        />
      )}
      {importTerms.error ? <p className="text-sm text-destructive">{errorMessage(importTerms.error)}</p> : null}
      {importTerms.data === undefined ? null : (
        <Notice tone={Tones.ok} title="Imported">
          <p className="text-sm">
            {importTerms.data.added} new, {importTerms.data.changed} changed, {importTerms.data.unchanged} unchanged.
            {importTerms.data.added + importTerms.data.changed > 0
              ? ' The sentences that contain them are being translated again.'
              : ''}
          </p>
        </Notice>
      )}
    </section>
  );
}

export default function Glossary({ workspaceId, projectId }: Props) {
  const utils = trpc.useUtils();
  const glossaryQuery = trpc.help.glossary.useQuery({ workspaceId, projectId });
  const siteQuery = trpc.help.site.useQuery({ workspaceId, projectId });
  const [formKey, setFormKey] = useState(0);
  const add = trpc.help.addGlossaryTerm.useMutation({
    onSuccess: async () => {
      setFormKey(key => key + 1);
      await utils.help.glossary.invalidate({ workspaceId, projectId });
    },
  });

  if (glossaryQuery.isPending || siteQuery.isPending) {
    return <Spinner />;
  }
  if (glossaryQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(glossaryQuery.error)}</p>;
  }
  const offered: readonly string[] = siteQuery.data?.site?.locales ?? [];
  const locales = HELP_LOCALES.filter(locale => offered.includes(locale));
  const { terms } = glossaryQuery.data;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href={Routes.projectHelp(workspaceId, projectId)}
          className="text-sm text-muted-foreground hover:text-foreground">
          ← Help center
        </Link>
        <h2 className="text-lg font-semibold tracking-tight">Glossary</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Words every translation follows. A kept term (a product name, a button label) stays exactly as written in
          every language; a fixed term is always translated the way you set. Changing a term translates again only the
          sentences that contain it, and a reviewed language gets a machine draft to accept instead of new text.
        </p>
      </div>
      <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h3 className="text-sm font-medium">Add a term</h3>
        <TermForm
          key={formKey}
          locales={locales}
          initial={EMPTY}
          label="Add term"
          isPending={add.isPending}
          onSubmit={draft => {
            add.mutate({ workspaceId, projectId, term: inputOf(draft) });
          }}
        />
        {add.error ? <p className="text-sm text-destructive">{errorMessage(add.error)}</p> : null}
      </section>
      {terms.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No terms yet.
        </p>
      ) : (
        <ul aria-label="Glossary terms" className="divide-y divide-border rounded-xl border border-border">
          {terms.map(term => (
            <TermRow key={term.id} term={term} locales={locales} workspaceId={workspaceId} projectId={projectId} />
          ))}
        </ul>
      )}
      <CsvImport workspaceId={workspaceId} projectId={projectId} terms={terms} />
    </div>
  );
}
