// "Was this helpful?" for one article in the console (#216): readers' yes and no answers
// over the last 30 days (one per reader a day) and the newest comments sent from apps.
import { HELP_LOCALE_NAMES } from '@mocco/common/help';

import { Ago, errorMessage, Spinner } from '@frontend/components/notifications/notification-ui';
import { trpc } from '@frontend/lib/trpc';

interface Props {
  workspaceId: string;
  projectId: string;
  articleId: string;
}

const languageName = (locale: string) => (HELP_LOCALE_NAMES as Record<string, string>)[locale] ?? locale;

export default function HelpfulnessPanel({ workspaceId, projectId, articleId }: Props) {
  const helpfulnessQuery = trpc.help.helpfulness.useQuery({ workspaceId, projectId, articleId });

  if (helpfulnessQuery.isPending) {
    return <Spinner />;
  }
  if (helpfulnessQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(helpfulnessQuery.error)}</p>;
  }
  const { days, helpful, notHelpful, comments } = helpfulnessQuery.data;
  const total = helpful + notHelpful;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="helpfulness-heading">
      <h2 id="helpfulness-heading" className="text-sm font-medium">
        Was this helpful?
      </h2>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">{`No answers in the last ${days} days.`}</p>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl border border-border px-3 py-2 text-sm">
          <p>
            <span className="font-medium">{`${Math.round((helpful / total) * 100)}% helpful`}</span>
            <span className="text-muted-foreground">{` · ${helpful} yes, ${notHelpful} no in the last ${days} days`}</span>
          </p>
          <div
            className="flex h-1.5 overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`${helpful} of ${total} answers were yes`}>
            <div className="bg-foreground" style={{ width: `${(helpful / total) * 100}%` }} />
          </div>
        </div>
      )}
      {comments.length === 0 ? null : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border text-sm">
          {comments.map(entry => (
            <li key={entry.createdAt.toISOString() + entry.comment} className="flex flex-col gap-1 px-3 py-2">
              <span>{entry.comment}</span>
              <span className="text-xs text-muted-foreground">
                {entry.helpful ? 'Yes' : 'No'} · {languageName(entry.locale)} · <Ago date={entry.createdAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
