// Reviewing one language of an article (#213): the published source beside the
// translation, who reviewed it and when, what changed in the source since the text was
// made (segment by segment), and the machine draft for the new source to accept or edit.
// Saving marks the text reviewed; saving the machine's text unchanged marks it reviewed too.
import { HELP_LOCALE_NAMES, SegmentChanges } from '@mocco/common/help';
import { useState } from 'react';

import DocContent from '@frontend/components/doc-content';
import {
  Ago,
  errorMessage,
  inputClass,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { helpArticleBlocks } from '@frontend/lib/help-markdown';
import { trpc } from '@frontend/lib/trpc';

import type { AppRouter } from '@mocco/backend/trpc/root';
import type { HelpLocale } from '@mocco/common/help';
import type { inferRouterOutputs } from '@trpc/server';

type Review = inferRouterOutputs<AppRouter>['help']['translationReview'];
type Change = NonNullable<Review['changes']>[number];

interface Scope {
  workspaceId: string;
  projectId: string;
  articleId: string;
}

export const languageName = (locale: string) => (HELP_LOCALE_NAMES as Record<string, string>)[locale] ?? locale;

const CHANGE_LABELS = {
  [SegmentChanges.changed]: 'Changed',
  [SegmentChanges.added]: 'Added',
  [SegmentChanges.removed]: 'Removed',
} as const;

/** The source segments that changed since the translation was made; unchanged ones are only counted. */
function SourceChanges({ changes }: { changes: readonly Change[] }) {
  const changed = changes.filter(change => change.change !== SegmentChanges.same);
  const unchanged = changes.length - changed.length;
  return (
    <section
      aria-label="What changed in the source"
      className="flex flex-col gap-2 rounded-xl border border-amber-500/40 p-3">
      <p className="text-sm font-medium">The source changed since this translation</p>
      <p className="text-xs text-muted-foreground">
        {changed.length} {changed.length === 1 ? 'segment' : 'segments'} to review; {unchanged} unchanged.
      </p>
      <ol className="flex flex-col gap-2">
        {changed.map((change, i) => (
          <li
            // eslint-disable-next-line @eslint-react/no-array-index-key -- the diff has no ids; its order is fixed per response
            key={i}
            className="flex flex-col gap-1 rounded-lg bg-amber-500/10 px-3 py-2 text-sm">
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
              {change.change === SegmentChanges.same ? null : CHANGE_LABELS[change.change]} · {change.kind}
            </span>
            {change.before === null ? null : (
              <del className="text-muted-foreground" aria-label={`Before: ${change.before}`}>
                {change.before}
              </del>
            )}
            {change.after === null ? null : (
              <ins className="no-underline" aria-label={`Now: ${change.after}`}>
                {change.after}
              </ins>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReviewForm({ scope, review, onDone }: { scope: Scope; review: Review; onDone: () => void }) {
  const utils = trpc.useUtils();
  const source = review.source ?? { title: '', body: '' };
  const [title, setTitle] = useState(review.text?.title ?? source.title);
  const [body, setBody] = useState(review.text?.body ?? source.body);
  const [isPreview, setIsPreview] = useState(false);
  const locale = review.locale as HelpLocale;
  const refresh = async () => {
    await utils.help.translations.invalidate(scope);
    await utils.help.translationReview.invalidate({ ...scope, locale });
  };
  const save = trpc.help.saveTranslation.useMutation({
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  const accept = trpc.help.acceptProposal.useMutation({
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  const name = languageName(review.locale);
  const { proposal } = review;
  const isUnchangedMachine = review.textKind === 'machine' && title === review.text?.title && body === review.text.body;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Review {name}</h3>
        <span className="text-xs text-muted-foreground">
          {review.reviewedAt === null ? (
            'Not reviewed yet. Saving marks it reviewed: the machine won’t replace it.'
          ) : (
            <>
              Reviewed by {review.reviewedBy ?? 'a former member'} · <Ago date={review.reviewedAt} />
            </>
          )}
        </span>
      </div>
      {review.changes === null ? null : <SourceChanges changes={review.changes} />}
      {proposal === null ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 p-3 text-sm">
          <StatusBadge tone={Tones.neutral}>Machine draft ready</StatusBadge>
          <span className="min-w-0 flex-1 text-muted-foreground">
            It follows the new source: the reviewed sentences are kept and the changed ones drafted.
          </span>
          <Button
            className="h-7 text-xs"
            pending={accept.isPending}
            onClick={() => {
              accept.mutate({ ...scope, locale, proposalRevisionId: proposal.revisionId });
            }}>
            Accept draft
          </Button>
          <Button
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              setTitle(proposal.title);
              setBody(proposal.body);
              setIsPreview(false);
            }}>
            Edit draft
          </Button>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="Source" className="flex min-w-0 flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Source</p>
          <div className="flex min-h-80 flex-col gap-4 rounded-xl border border-border bg-muted/20 p-5">
            <h1 className="text-2xl font-semibold tracking-tight">{source.title}</h1>
            <DocContent blocks={helpArticleBlocks(source.body)} />
          </div>
        </section>
        <section aria-label={`Translation in ${name}`} className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-muted-foreground">{name}</p>
            <div className="ml-auto flex gap-1" role="group" aria-label="View">
              <Button
                variant={isPreview ? 'outline' : 'default'}
                className="h-6 px-2 text-xs"
                aria-pressed={!isPreview}
                onClick={() => {
                  setIsPreview(false);
                }}>
                Markdown
              </Button>
              <Button
                variant={isPreview ? 'default' : 'outline'}
                className="h-6 px-2 text-xs"
                aria-pressed={isPreview}
                onClick={() => {
                  setIsPreview(true);
                }}>
                Preview
              </Button>
            </div>
          </div>
          {isPreview ? (
            <div className="flex min-h-80 flex-col gap-4 rounded-xl border border-border p-5" aria-label="Preview">
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              <DocContent blocks={helpArticleBlocks(body)} />
            </div>
          ) : (
            <>
              <input
                aria-label={`Title in ${name}`}
                className={`${inputClass} text-base font-medium`}
                value={title}
                onChange={event => {
                  setTitle(event.target.value);
                }}
              />
              <textarea
                aria-label={`Article in ${name} (Markdown)`}
                className={`${inputClass} min-h-80 flex-1 font-mono text-xs leading-6`}
                value={body}
                onChange={event => {
                  setBody(event.target.value);
                }}
              />
            </>
          )}
        </section>
      </div>
      <div className="flex items-center gap-2">
        <Button
          className="text-sm"
          pending={save.isPending}
          onClick={() => {
            save.mutate({ ...scope, locale, title, body });
          }}>
          {isUnchangedMachine ? 'Mark reviewed' : 'Save as reviewed'}
        </Button>
        <Button variant="outline" className="text-sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {save.error ? <p className="text-sm text-destructive">{errorMessage(save.error)}</p> : null}
      {accept.error ? <p className="text-sm text-destructive">{errorMessage(accept.error)}</p> : null}
    </div>
  );
}

export default function TranslationReview({
  scope,
  locale,
  onDone,
}: {
  scope: Scope;
  locale: string;
  onDone: () => void;
}) {
  const reviewQuery = trpc.help.translationReview.useQuery({ ...scope, locale: locale as HelpLocale });
  if (reviewQuery.isPending) {
    return <Spinner />;
  }
  if (reviewQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(reviewQuery.error)}</p>;
  }
  // Remount when a new draft lands, so the form starts from the newest text.
  return (
    <ReviewForm
      key={`${reviewQuery.data.text?.title ?? ''}:${reviewQuery.data.proposal?.revisionId ?? ''}`}
      scope={scope}
      review={reviewQuery.data}
      onDone={onDone}
    />
  );
}
