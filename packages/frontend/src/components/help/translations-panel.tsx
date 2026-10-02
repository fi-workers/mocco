// An article's translations (#96): each language the site offers, with its state —
// machine-translated, reviewed by a person, out of date with the source, or failed —
// and an editor to review one (a person's text is never overwritten by the machine).
import { HELP_LOCALE_NAMES } from '@mocco/common/help';
import { useState } from 'react';

import DocContent from '@frontend/components/doc-content';
import {
  errorMessage,
  inputClass,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { helpArticleBlocks } from '@frontend/lib/help-markdown';
import { trpc } from '@frontend/lib/trpc';

import type { HelpLocale } from '@mocco/common/help';

interface Props {
  workspaceId: string;
  projectId: string;
  articleId: string;
  /** The published source, the starting point for a language without text. */
  source: { title: string; body: string } | null;
}

interface Entry {
  locale: string;
  state: 'pending' | 'auto' | 'reviewed' | 'failed' | null;
  isStale: boolean;
  lastError: string | null;
  title: string | null;
  body: string | null;
}

const languageName = (locale: string) => (HELP_LOCALE_NAMES as Record<string, string>)[locale] ?? locale;

function StateBadges({ entry }: { entry: Entry }) {
  return (
    <>
      {entry.state === null ? <StatusBadge tone={Tones.neutral}>Not translated</StatusBadge> : null}
      {entry.state === 'pending' ? <StatusBadge tone={Tones.neutral}>Translating…</StatusBadge> : null}
      {entry.state === 'auto' ? <StatusBadge tone={Tones.ok}>Machine translated</StatusBadge> : null}
      {entry.state === 'reviewed' ? <StatusBadge tone={Tones.ok}>Reviewed</StatusBadge> : null}
      {entry.state === 'failed' ? <StatusBadge tone={Tones.danger}>Failed</StatusBadge> : null}
      {entry.isStale ? <StatusBadge tone={Tones.warn}>Source changed</StatusBadge> : null}
    </>
  );
}

function TranslationEditor({
  workspaceId,
  projectId,
  articleId,
  entry,
  source,
  onDone,
}: Omit<Props, 'source'> & { entry: Entry; source: { title: string; body: string }; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState(entry.title ?? source.title);
  const [body, setBody] = useState(entry.body ?? source.body);
  const save = trpc.help.saveTranslation.useMutation({
    onSuccess: async () => {
      await utils.help.translations.invalidate({ workspaceId, projectId, articleId });
      onDone();
    },
  });
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{languageName(entry.locale)}</h3>
        <span className="text-xs text-muted-foreground">
          Saving marks it reviewed: the machine won&apos;t replace it.
        </span>
      </div>
      <input
        aria-label={`Title in ${languageName(entry.locale)}`}
        className={`${inputClass} text-base font-medium`}
        value={title}
        onChange={event => {
          setTitle(event.target.value);
        }}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <textarea
          aria-label={`Article in ${languageName(entry.locale)} (Markdown)`}
          className={`${inputClass} min-h-80 font-mono text-xs leading-6`}
          value={body}
          onChange={event => {
            setBody(event.target.value);
          }}
        />
        <div className="flex min-h-80 flex-col gap-4 rounded-xl border border-border p-5" aria-label="Preview">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <DocContent blocks={helpArticleBlocks(body)} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          className="text-sm"
          pending={save.isPending}
          onClick={() => {
            save.mutate({ workspaceId, projectId, articleId, locale: entry.locale as HelpLocale, title, body });
          }}>
          Save translation
        </Button>
        <Button variant="outline" className="text-sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {save.error ? <p className="text-sm text-destructive">{errorMessage(save.error)}</p> : null}
    </div>
  );
}

export default function TranslationsPanel({ workspaceId, projectId, articleId, source }: Props) {
  const utils = trpc.useUtils();
  const translationsQuery = trpc.help.translations.useQuery(
    { workspaceId, projectId, articleId },
    // Machine translations land in the background; look again while any is pending.
    { refetchInterval: query => (query.state.data?.locales.some(entry => entry.state === 'pending') ? 3000 : false) },
  );
  const retranslate = trpc.help.retranslate.useMutation({
    onSuccess: async () => {
      await utils.help.translations.invalidate({ workspaceId, projectId, articleId });
    },
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  if (translationsQuery.isPending) {
    return <Spinner />;
  }
  if (translationsQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(translationsQuery.error)}</p>;
  }
  const { locales, isAvailable } = translationsQuery.data;
  if (locales.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Translations</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          {isAvailable
            ? 'Publishing translates the article into each language. Review a translation to fix it; reviewed text stays until you change it.'
            : 'Automatic translation is off for this Mocco. You can still write each language yourself.'}
        </p>
      </div>
      {source === null ? (
        <p className="text-sm text-muted-foreground">Publish the article to translate it.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border text-sm">
          {locales.map(entry => (
            <li key={entry.locale} className="flex flex-col gap-2 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-28 font-medium">{languageName(entry.locale)}</span>
                <StateBadges entry={entry} />
                {entry.title === null ? null : (
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.title}</span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => {
                      setEditing(entry.locale);
                    }}>
                    {entry.state === 'reviewed' ? 'Edit' : 'Review'}
                  </Button>
                  {isAvailable && confirming !== entry.locale ? (
                    <Button
                      variant="outline"
                      className="h-7 text-xs"
                      pending={retranslate.isPending && retranslate.variables.locale === entry.locale}
                      onClick={() => {
                        if (entry.state === 'reviewed') {
                          setConfirming(entry.locale);
                          return;
                        }
                        retranslate.mutate({ workspaceId, projectId, articleId, locale: entry.locale as HelpLocale });
                      }}>
                      Translate again
                    </Button>
                  ) : null}
                  {confirming === entry.locale ? (
                    <>
                      <span className="text-xs text-muted-foreground">Replace the reviewed text?</span>
                      <Button
                        variant="destructive"
                        className="h-7 text-xs"
                        onClick={() => {
                          setConfirming(null);
                          retranslate.mutate({ workspaceId, projectId, articleId, locale: entry.locale as HelpLocale });
                        }}>
                        Replace
                      </Button>
                      <Button
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => {
                          setConfirming(null);
                        }}>
                        Keep
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
              {entry.state === 'failed' && entry.lastError !== null ? (
                <p className="text-xs text-destructive">{entry.lastError}</p>
              ) : null}
              {editing === entry.locale ? (
                <TranslationEditor
                  workspaceId={workspaceId}
                  projectId={projectId}
                  articleId={articleId}
                  entry={entry}
                  source={source}
                  onDone={() => {
                    setEditing(null);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {retranslate.error ? <p className="text-sm text-destructive">{errorMessage(retranslate.error)}</p> : null}
    </section>
  );
}
