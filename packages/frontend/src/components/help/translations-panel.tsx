// An article's translations (#96): each language the site offers, with its state —
// machine-translated, reviewed by a person, out of date with the source, or failed —
// and the review editor for one (translation-review.tsx; a person's text is never
// overwritten by the machine unless they confirm it).
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

import TranslationReview, { languageName } from '@frontend/components/help/translation-review';
import { errorMessage, Spinner, StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
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
  state: 'pending' | 'translating' | 'auto' | 'reviewed' | 'failed' | null;
  isStale: boolean;
  hasProposal: boolean;
  lastError: string | null;
  title: string | null;
  body: string | null;
}

function StateBadges({ entry }: { entry: Entry }) {
  return (
    <>
      {entry.state === null ? <StatusBadge tone={Tones.neutral}>Not translated</StatusBadge> : null}
      {entry.state === 'pending' ? <StatusBadge tone={Tones.neutral}>Waiting</StatusBadge> : null}
      {entry.state === 'translating' ? <StatusBadge tone={Tones.neutral}>Translating…</StatusBadge> : null}
      {entry.state === 'auto' ? <StatusBadge tone={Tones.ok}>Machine translated</StatusBadge> : null}
      {entry.state === 'reviewed' ? <StatusBadge tone={Tones.ok}>Reviewed</StatusBadge> : null}
      {entry.state === 'failed' ? <StatusBadge tone={Tones.danger}>Failed</StatusBadge> : null}
      {entry.isStale ? <StatusBadge tone={Tones.warn}>Source changed</StatusBadge> : null}
      {entry.hasProposal ? <StatusBadge tone={Tones.neutral}>Machine draft ready</StatusBadge> : null}
    </>
  );
}

export default function TranslationsPanel({ workspaceId, projectId, articleId, source }: Props) {
  const utils = trpc.useUtils();
  const translationsQuery = trpc.help.translations.useQuery(
    { workspaceId, projectId, articleId },
    // Machine translations land in the background; look again while any is queued or running
    // (a language waiting for next month's allowance says so and isn't polled).
    {
      refetchInterval: query =>
        query.state.data?.locales.some(
          entry => entry.state === 'translating' || (entry.state === 'pending' && entry.lastError === null),
        )
          ? 3000
          : false,
    },
  );
  const retranslate = trpc.help.retranslate.useMutation({
    onSuccess: async () => {
      await utils.help.translations.invalidate({ workspaceId, projectId, articleId });
    },
  });
  // `?review=<locale>` (a link from the translations dashboard) opens that language's review
  // until the person opens or closes another one.
  const router = useRouter();
  const requested = typeof router.query.review === 'string' ? router.query.review : null;
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const editing = chosen === undefined ? requested : chosen;
  const setEditing = setChosen;
  const isLoaded = translationsQuery.data !== undefined;
  useEffect(() => {
    if (requested !== null && isLoaded) {
      document.querySelector(`#translation-${requested}`)?.scrollIntoView({ block: 'start' });
    }
  }, [requested, isLoaded]);
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
            <li key={entry.locale} id={`translation-${entry.locale}`} className="flex flex-col gap-2 px-3 py-2">
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
                          retranslate.mutate({
                            workspaceId,
                            projectId,
                            articleId,
                            locale: entry.locale as HelpLocale,
                            confirm: true,
                          });
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
              {entry.state === 'pending' && entry.lastError !== null ? (
                <p className="text-xs text-muted-foreground">{entry.lastError}</p>
              ) : null}
              {editing === entry.locale ? (
                <TranslationReview
                  scope={{ workspaceId, projectId, articleId }}
                  locale={entry.locale}
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
