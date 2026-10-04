// Whether AI companies may train on a help center (#363). Search engines and AI search
// always read the public site; this only decides whether robots.txt also lets in the
// crawlers that collect training data (GPTBot, ClaudeBot, Google-Extended and others).

import { errorMessage } from '@frontend/components/notifications/notification-ui';
import { trpc } from '@frontend/lib/trpc';

interface Props {
  workspaceId: string;
  projectId: string;
  allowAiTraining: boolean;
}

export default function HelpCrawlers({ workspaceId, projectId, allowAiTraining }: Props) {
  const utils = trpc.useUtils();
  const change = trpc.help.setAiTraining.useMutation({
    onSuccess: async () => {
      await utils.help.site.invalidate({ workspaceId, projectId });
    },
  });

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Search engines and AI</h3>
        <p className="max-w-prose text-sm text-muted-foreground">
          Search engines and AI search (Google, Bing, ChatGPT search, Claude, Perplexity) can always read your help
          center, so people find answers there. This decides whether AI companies may also use it to train their models.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={allowAiTraining}
          disabled={change.isPending}
          onChange={event => {
            change.mutate({ workspaceId, projectId, allowAiTraining: event.target.checked });
          }}
        />
        Allow AI training crawlers
      </label>
      {change.error ? <p className="text-sm text-destructive">{errorMessage(change.error)}</p> : null}
    </section>
  );
}
