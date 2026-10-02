// Writing one help article (#96): title and Markdown side by side with a live preview,
// saved as a new revision each time; publish puts the draft on the public site. History
// lists every save, and restoring one makes it the draft again.

import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import DocContent from '@frontend/components/doc-content';
import TranslationsPanel from '@frontend/components/help/translations-panel';
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
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

/** Nothing but spaces. */
// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const isBlank = (value: string) => value.trim() === '';

interface Props {
  workspaceId: string;
  projectId: string;
  articleId: string;
}

function Editor({
  workspaceId,
  projectId,
  articleId,
  initialTitle,
  initialBody,
}: Props & { initialTitle: string; initialBody: string }) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const refresh = async () => {
    await utils.help.article.invalidate({ workspaceId, projectId, articleId });
    await utils.help.history.invalidate({ workspaceId, projectId, articleId });
    await utils.help.tree.invalidate();
  };
  const save = trpc.help.saveDraft.useMutation({ onSuccess: refresh });
  const publish = trpc.help.publish.useMutation({ onSuccess: refresh });
  const isChanged = title !== initialTitle || body !== initialBody;
  const input = { workspaceId, projectId, articleId };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Title"
          className={`${inputClass} min-w-64 flex-1 text-base font-medium`}
          value={title}
          onChange={event => {
            setTitle(event.target.value);
          }}
        />
        <Button
          variant="outline"
          className="text-sm"
          pending={save.isPending}
          disabled={!isChanged || isBlank(title)}
          onClick={() => {
            save.mutate({ ...input, title, body });
          }}>
          Save draft
        </Button>
        <Button
          className="text-sm"
          pending={publish.isPending}
          disabled={isChanged}
          title={isChanged ? 'Save the draft first' : undefined}
          onClick={() => {
            publish.mutate(input);
          }}>
          Publish
        </Button>
      </div>
      {(save.error ?? publish.error) ? (
        <p className="text-sm text-destructive">{errorMessage(save.error ?? publish.error)}</p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <textarea
          aria-label="Article (Markdown)"
          className={`${inputClass} min-h-[28rem] font-mono text-xs leading-6`}
          value={body}
          placeholder="Write in Markdown: ## headings, lists, **bold**, [links](https://…), > notes and tables."
          onChange={event => {
            setBody(event.target.value);
          }}
        />
        <div className="flex min-h-[28rem] flex-col gap-4 rounded-xl border border-border p-5" aria-label="Preview">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <DocContent blocks={helpArticleBlocks(body)} />
        </div>
      </div>
    </div>
  );
}

function History({ workspaceId, projectId, articleId }: Props) {
  const utils = trpc.useUtils();
  const historyQuery = trpc.help.history.useQuery({ workspaceId, projectId, articleId });
  const restore = trpc.help.restore.useMutation({
    onSuccess: async () => {
      await utils.help.article.invalidate({ workspaceId, projectId, articleId });
      await utils.help.history.invalidate({ workspaceId, projectId, articleId });
    },
  });
  const revisions = historyQuery.data?.revisions ?? [];
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">History</h2>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border text-sm">
        {revisions.map((revision, index) => (
          <li key={revision.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 truncate">{revision.title}</span>
            {revision.kind === 'restore' ? <StatusBadge tone={Tones.neutral}>Restored</StatusBadge> : null}
            <span className="text-xs text-muted-foreground">
              <Ago date={revision.createdAt} />
            </span>
            {index === 0 ? (
              <span className="text-xs text-muted-foreground">Current draft</span>
            ) : (
              <Button
                variant="outline"
                className="h-7 text-xs"
                pending={restore.isPending && restore.variables.revisionId === revision.id}
                onClick={() => {
                  restore.mutate({ workspaceId, projectId, articleId, revisionId: revision.id });
                }}>
                Restore
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function ArticleEditor({ workspaceId, projectId, articleId }: Props) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const articleQuery = trpc.help.article.useQuery({ workspaceId, projectId, articleId });
  const unpublish = trpc.help.unpublish.useMutation({
    onSuccess: async () => {
      await utils.help.article.invalidate({ workspaceId, projectId, articleId });
      await utils.help.tree.invalidate();
    },
  });
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const remove = trpc.help.deleteArticle.useMutation({
    onSuccess: async () => {
      await utils.help.tree.invalidate();
      await router.push(Routes.projectHelp(workspaceId, projectId));
    },
  });

  if (articleQuery.isPending) {
    return <Spinner />;
  }
  if (articleQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(articleQuery.error)}</p>;
  }
  const article = articleQuery.data;
  const isPublished = article.status === 'published';
  const draft = article.draft ?? { id: 'none', title: '', body: '' };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Link href={Routes.projectHelp(workspaceId, projectId)} className="underline-offset-2 hover:underline">
          Help center
        </Link>
        <span aria-hidden="true">/</span>
        <span className="font-mono text-xs">{`${article.shortId}-${article.slug}`}</span>
        {isPublished ? (
          <StatusBadge tone={Tones.ok}>Published</StatusBadge>
        ) : (
          <StatusBadge tone={Tones.neutral}>Draft</StatusBadge>
        )}
        {isPublished && article.draft?.id !== article.published?.id ? (
          <StatusBadge tone={Tones.warn}>Unpublished changes</StatusBadge>
        ) : null}
        {isPublished ? (
          <Button
            variant="outline"
            className="ml-auto h-7 text-xs"
            pending={unpublish.isPending}
            onClick={() => {
              unpublish.mutate({ workspaceId, projectId, articleId });
            }}>
            Unpublish
          </Button>
        ) : null}
      </div>
      {/* Keyed by the draft, so restoring or saving reloads the fields. */}
      <Editor
        key={draft.id}
        workspaceId={workspaceId}
        projectId={projectId}
        articleId={articleId}
        initialTitle={draft.title}
        initialBody={draft.body}
      />
      <TranslationsPanel
        workspaceId={workspaceId}
        projectId={projectId}
        articleId={articleId}
        source={article.published === null ? null : { title: article.published.title, body: article.published.body }}
      />
      <History workspaceId={workspaceId} projectId={projectId} articleId={articleId} />
      <section className="flex flex-col gap-2 border-t border-border pt-4">
        {isConfirmingDelete ? (
          <div className="flex items-center gap-2">
            <Button
              variant="destructive"
              className="text-sm"
              pending={remove.isPending}
              onClick={() => {
                remove.mutate({ workspaceId, projectId, articleId });
              }}>
              Yes, delete
            </Button>
            <Button
              variant="outline"
              className="text-sm"
              onClick={() => {
                setIsConfirmingDelete(false);
              }}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            className="w-fit text-sm text-destructive"
            onClick={() => {
              setIsConfirmingDelete(true);
            }}>
            Delete article
          </Button>
        )}
      </section>
    </div>
  );
}
