// Writing one help article (#96): title and Markdown side by side with a live preview.
// The draft saves itself a moment after you stop typing (#208); one editing session is
// one revision in History, and restoring one makes it the draft again. Publish puts the
// draft on the public site. Images pasted, dropped or picked are uploaded and referenced
// by their public URL.

import { HELP_IMAGE_TYPES } from '@mocco/common/help';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';

import DocContent from '@frontend/components/doc-content';
import { useEditorImages } from '@frontend/components/help/editor-images';
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
import { fireAndForget } from '@frontend/lib/fire-and-forget';
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

/** How long after the last keystroke the draft saves itself. */
const AUTOSAVE_DELAY_MS = 2500;

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const images = useEditorImages({ workspaceId, projectId, textareaRef, setBody });
  const uploadingNoun = images.pending === 1 ? 'image' : 'images';
  const imageHint =
    images.pending === 0
      ? 'Paste or drop PNG, JPEG, WebP or GIF images up to 10 MB.'
      : `Uploading ${images.pending} ${uploadingNoun}…`;
  const refresh = async () => {
    await utils.help.article.invalidate({ workspaceId, projectId, articleId });
    await utils.help.history.invalidate({ workspaceId, projectId, articleId });
    await utils.help.tree.invalidate();
  };
  const save = trpc.help.saveDraft.useMutation({ onSuccess: refresh });
  const publish = trpc.help.publish.useMutation({ onSuccess: refresh });
  const { mutate: saveDraft, isPending: isSaving } = save;
  const isChanged = title !== initialTitle || body !== initialBody;
  const input = { workspaceId, projectId, articleId };
  // A failed save isn't retried until the text changes again (or Try again).
  const hasFailedOnThisText = save.isError && save.variables.title === title && save.variables.body === body;
  // A placeholder for an uploading image isn't saved; the finished image is.
  const canAutosave = isChanged && !isBlank(title) && images.pending === 0 && !hasFailedOnThisText;

  useEffect(() => {
    if (!canAutosave || isSaving) {
      return undefined;
    }
    const timer = setTimeout(() => {
      saveDraft({ workspaceId, projectId, articleId, title, body });
    }, AUTOSAVE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [canAutosave, isSaving, saveDraft, workspaceId, projectId, articleId, title, body]);

  // Leaving with unsaved text asks first.
  useEffect(() => {
    if (!isChanged) {
      return undefined;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    /* eslint-disable unicorn/no-unnecessary-global-this -- no-restricted-globals bans the bare names */
    globalThis.addEventListener('beforeunload', warn);
    return () => {
      globalThis.removeEventListener('beforeunload', warn);
    };
    /* eslint-enable unicorn/no-unnecessary-global-this */
  }, [isChanged]);

  /** Publishing saves unsaved text first, so what you see is what goes out. */
  const saveAndPublish = async () => {
    if (isChanged) {
      await save.mutateAsync({ ...input, title, body });
    }
    publish.mutate(input);
  };

  let saveState = 'All changes saved';
  if (isSaving) {
    saveState = 'Saving…';
  } else if (hasFailedOnThisText) {
    saveState = "Couldn't save";
  } else if (isChanged) {
    saveState = isBlank(title) ? 'Add a title to save' : 'Unsaved changes';
  }

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
        <span role="status" className="text-xs text-muted-foreground">
          {saveState}
        </span>
        {hasFailedOnThisText ? (
          <Button
            variant="outline"
            className="text-sm"
            onClick={() => {
              saveDraft({ ...input, title, body });
            }}>
            Try again
          </Button>
        ) : null}
        <Button
          className="text-sm"
          pending={publish.isPending}
          disabled={isBlank(title) || images.pending > 0 || isSaving}
          onClick={() => {
            fireAndForget(saveAndPublish());
          }}>
          Publish
        </Button>
      </div>
      {(save.error ?? publish.error) ? (
        <p className="text-sm text-destructive">{errorMessage(save.error ?? publish.error)}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Button
          variant="outline"
          className="h-7 text-xs"
          pending={images.pending > 0}
          onClick={() => {
            pickerRef.current?.click();
          }}>
          Add image
        </Button>
        <input
          ref={pickerRef}
          type="file"
          accept={HELP_IMAGE_TYPES.join(',')}
          multiple
          hidden
          aria-label="Image files"
          onChange={event => {
            images.add([...(event.target.files ?? [])]);
            // Picking the same file again should upload it again.
            if (pickerRef.current !== null) {
              pickerRef.current.value = '';
            }
          }}
        />
        <span role="status">{imageHint}</span>
      </div>
      {images.problems.length > 0 ? (
        <div role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <ul className="flex-1">
            {images.problems.map(problem => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <Button variant="outline" className="h-7 text-xs" onClick={images.dismiss}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <textarea
          ref={textareaRef}
          aria-label="Article (Markdown)"
          className={`${inputClass} min-h-[28rem] font-mono text-xs leading-6`}
          value={body}
          placeholder="Write in Markdown: ## headings, lists, **bold**, [links](https://…), > notes and tables."
          onChange={event => {
            setBody(event.target.value);
          }}
          onPaste={images.onPaste}
          onDragOver={images.onDragOver}
          onDrop={images.onDrop}
        />
        <div className="flex min-h-[28rem] flex-col gap-4 rounded-xl border border-border p-5" aria-label="Preview">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <DocContent blocks={helpArticleBlocks(body)} />
        </div>
      </div>
    </div>
  );
}

function History({ workspaceId, projectId, articleId, onRestored }: Props & { onRestored: () => void }) {
  const utils = trpc.useUtils();
  const historyQuery = trpc.help.history.useQuery({ workspaceId, projectId, articleId });
  const restore = trpc.help.restore.useMutation({
    onSuccess: async () => {
      await utils.help.article.invalidate({ workspaceId, projectId, articleId });
      await utils.help.history.invalidate({ workspaceId, projectId, articleId });
      onRestored();
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
  // Bumped by a restore, which replaces the text being edited; saving keeps the fields as they are.
  const [restores, setRestores] = useState(0);
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
      {/* Keyed by restores, so restoring reloads the fields while saving doesn't interrupt typing. */}
      <Editor
        key={restores}
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
      <History
        workspaceId={workspaceId}
        projectId={projectId}
        articleId={articleId}
        onRestored={() => {
          setRestores(count => count + 1);
        }}
      />
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
