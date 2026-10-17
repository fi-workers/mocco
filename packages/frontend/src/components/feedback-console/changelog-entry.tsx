// One changelog entry in the console (#176): its title, address, tags, Markdown text (with the
// public page's rendering beside it) and the board's posts it announces; then publishing it now,
// scheduling it, taking it back to a draft or deleting it. Publishing or scheduling saves unsaved
// edits first, so what goes out is what is on the screen.
import { ChangelogEntryStates, ChangelogTags, CHANGELOG_SLUG_PATTERN, FeedbackPostSorts } from '@mocco/common/feedback';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import DocContent from '@frontend/components/doc-content';
import {
  errorMessage,
  inputClass,
  labelClass,
  Spinner,
  StatusBadge,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import {
  changelogStateLabels,
  changelogStateTones,
  formatWhen,
  publicBoardUrl,
  useHelpSiteSlug,
} from '@frontend/lib/feedback-console';
import { helpArticleBlocks } from '@frontend/lib/help-markdown';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { AppRouter } from '@mocco/backend/trpc/root';
import type { ChangelogTag } from '@mocco/common/feedback';
import type { inferRouterOutputs } from '@trpc/server';

type Entry = inferRouterOutputs<AppRouter>['changelog']['entry']['entry'];

interface Props {
  workspaceId: string;
  projectId: string;
  entryId: string;
}

const tagLabels: Record<ChangelogTag, string> = {
  [ChangelogTags.new]: 'New',
  [ChangelogTags.improved]: 'Improved',
  [ChangelogTags.fixed]: 'Fixed',
};

/** The tags with `tag` added or taken out. */
const toggled = (tags: readonly ChangelogTag[], tag: ChangelogTag, isOn: boolean): ChangelogTag[] =>
  isOn ? [...tags, tag] : tags.filter(other => other !== tag);

/** A `datetime-local` value an hour from now, on the minute, in the viewer's time zone. */
function inAnHour(): string {
  const at = new Date(Date.now() + 60 * 60 * 1000);
  at.setSeconds(0, 0);
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** The board's posts the entry announces: chips to remove, and a search to add more. */
function PostPicker({
  workspaceId,
  projectId,
  boardId,
  postIds,
  onChange,
}: Omit<Props, 'entryId'> & { boardId: string; postIds: readonly string[]; onChange: (ids: string[]) => void }) {
  const [search, setSearch] = useState('');
  const postsQuery = trpc.feedback.posts.useQuery({
    workspaceId,
    projectId,
    boardId,
    sort: FeedbackPostSorts.top,
    limit: 100,
  });
  const posts = (postsQuery.data?.posts ?? []).filter(post => post.mergedIntoPostId === null);
  const byId = new Map(posts.map(post => [post.id, post]));
  // eslint-disable-next-line sonarjs/null-dereference -- search is a useState<string>, never null
  const words = search
    .toLowerCase()
    .split(/\s+/u)
    .filter(word => word !== '');
  const candidates =
    words.length === 0
      ? []
      : posts
          .filter(post => !postIds.includes(post.id))
          .filter(post => words.every(word => post.title.toLowerCase().includes(word) || String(post.number) === word))
          .slice(0, 8);

  return (
    <div className="flex flex-col gap-2">
      <span className={labelClass}>Posts it shipped</span>
      {postIds.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None yet. Each post you add shows &quot;Shipped in&quot; with a link to this entry.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {postIds.map(id => {
            const post = byId.get(id);
            return (
              <li key={id} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-sm">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {post === undefined ? '' : `#${String(post.number)}`}
                </span>
                <span className="max-w-60 truncate">{post?.title ?? 'A post'}</span>
                <button
                  type="button"
                  aria-label={`Remove ${post?.title ?? 'post'}`}
                  className="px-1 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    onChange(postIds.filter(other => other !== id));
                  }}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <input
        aria-label="Find a post to add"
        placeholder="Add a post: search by title or number"
        value={search}
        onChange={event => {
          setSearch(event.target.value);
        }}
        className={inputClass}
      />
      {candidates.length === 0 ? null : (
        <ul className="flex flex-col rounded-md border border-border">
          {candidates.map(post => (
            <li key={post.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                onClick={() => {
                  onChange([...postIds, post.id]);
                  setSearch('');
                }}>
                <span className="text-xs text-muted-foreground tabular-nums">#{post.number}</span>
                <span className="flex-1 truncate">{post.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Publish now, schedule, back to draft, delete. */
function Actions({
  workspaceId,
  projectId,
  entry,
  saveFirst,
  isSaving,
}: Omit<Props, 'entryId'> & { entry: Entry; saveFirst: () => Promise<void>; isSaving: boolean }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [publishAt, setPublishAt] = useState(inAnHour);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const refresh = async () => {
    await Promise.all([utils.changelog.entry.invalidate(), utils.changelog.entries.invalidate()]);
  };
  const publish = trpc.changelog.publish.useMutation({ onSuccess: refresh });
  const schedule = trpc.changelog.schedule.useMutation({ onSuccess: refresh });
  const unpublish = trpc.changelog.unpublish.useMutation({ onSuccess: refresh });
  const remove = trpc.changelog.delete.useMutation({
    onSuccess: async () => {
      await utils.changelog.entries.invalidate();
      await router.push(Routes.projectFeedbackChangelog(workspaceId, projectId));
    },
  });
  const input = { workspaceId, projectId, entryId: entry.id };
  const error = publish.error ?? schedule.error ?? unpublish.error ?? remove.error;
  const isBusy = isSaving || publish.isPending || schedule.isPending || unpublish.isPending;
  const isPublished = entry.state === ChangelogEntryStates.published;

  return (
    <div className="flex flex-col gap-3">
      {isPublished ? null : (
        <Button
          className="w-fit text-sm"
          disabled={isBusy}
          pending={publish.isPending}
          onClick={async () => {
            await saveFirst();
            publish.mutate(input);
          }}>
          Publish now
        </Button>
      )}
      {isPublished ? null : (
        <div className="flex flex-col gap-2">
          <label className={labelClass}>
            Or publish at
            <input
              type="datetime-local"
              value={publishAt}
              onChange={event => {
                setPublishAt(event.target.value);
              }}
              className={inputClass}
            />
          </label>
          <Button
            variant="outline"
            className="w-fit text-sm"
            disabled={isBusy || publishAt === ''}
            pending={schedule.isPending}
            onClick={async () => {
              await saveFirst();
              schedule.mutate({ ...input, publishAt: new Date(publishAt) });
            }}>
            {entry.state === ChangelogEntryStates.scheduled ? 'Move the time' : 'Schedule'}
          </Button>
        </div>
      )}
      {entry.state === ChangelogEntryStates.draft ? null : (
        <Button
          variant="outline"
          className="w-fit text-sm"
          disabled={isBusy}
          pending={unpublish.isPending}
          onClick={() => {
            unpublish.mutate(input);
          }}>
          {isPublished ? 'Unpublish' : 'Cancel the schedule'}
        </Button>
      )}
      {isConfirmingDelete ? (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-sm">
            Delete this entry?{isPublished ? ' Its public page and feed item go away.' : ''} This can&apos;t be undone.
          </p>
          <span className="flex gap-2">
            <Button
              variant="destructive"
              className="text-sm"
              pending={remove.isPending}
              onClick={() => {
                remove.mutate(input);
              }}>
              Delete
            </Button>
            <Button
              variant="ghost"
              className="text-sm"
              onClick={() => {
                setIsConfirmingDelete(false);
              }}>
              Cancel
            </Button>
          </span>
        </div>
      ) : (
        <Button
          variant="ghost"
          className="w-fit text-sm text-destructive"
          onClick={() => {
            setIsConfirmingDelete(true);
          }}>
          Delete entry
        </Button>
      )}
      {error ? <p className="text-sm text-destructive">{errorMessage(error)}</p> : null}
    </div>
  );
}

function Editor({ workspaceId, projectId, entry }: Omit<Props, 'entryId'> & { entry: Entry }) {
  const utils = trpc.useUtils();
  const boardQuery = trpc.feedback.board.useQuery({ workspaceId, projectId, boardId: entry.boardId });
  const siteSlug = useHelpSiteSlug(workspaceId, projectId);
  const [title, setTitle] = useState(entry.title);
  const [slug, setSlug] = useState(entry.slug);
  const [body, setBody] = useState(entry.bodyMd);
  const [tags, setTags] = useState<ChangelogTag[]>(entry.tags);
  const [postIds, setPostIds] = useState<string[]>(entry.postIds);
  const update = trpc.changelog.update.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.changelog.entry.invalidate(), utils.changelog.entries.invalidate()]);
    },
  });
  const isDirty =
    title !== entry.title ||
    slug !== entry.slug ||
    body !== entry.bodyMd ||
    tags.join(',') !== entry.tags.join(',') ||
    postIds.join(',') !== entry.postIds.join(',');
  const isSlugValid = CHANGELOG_SLUG_PATTERN.test(slug);
  // eslint-disable-next-line sonarjs/null-dereference -- title is a useState<string>, never null
  const canSave = isDirty && title.trim() !== '' && isSlugValid;
  const save = async () => {
    if (canSave) {
      await update.mutateAsync({ workspaceId, projectId, entryId: entry.id, title, slug, body, tags, postIds });
    }
  };
  const board = boardQuery.data?.board;
  const boardUrl =
    siteSlug === null || board === undefined || !board.isPublic ? null : publicBoardUrl(siteSlug, board.slug);
  const publicUrl =
    boardUrl === null || entry.state !== ChangelogEntryStates.published ? null : `${boardUrl}/changelog/${entry.slug}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={Routes.projectFeedbackChangelog(
            workspaceId,
            projectId,
            board === undefined ? {} : { board: board.slug },
          )}
          className="text-xs text-muted-foreground hover:text-foreground">
          ← Changelog
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={changelogStateTones[entry.state]}>{changelogStateLabels[entry.state]}</StatusBadge>
          <span className="text-xs text-muted-foreground">
            {entry.publishedAt !== null && <>Published {formatWhen(entry.publishedAt)}</>}
            {entry.publishAt !== null && <>Goes out {formatWhen(entry.publishAt)}</>}
          </span>
          {publicUrl === null ? null : (
            <a href={publicUrl} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-2">
              Public page
            </a>
          )}
        </div>
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <form
          aria-label="Edit entry"
          className="flex flex-col gap-4"
          onSubmit={async event => {
            event.preventDefault();
            await save();
          }}>
          <label className={labelClass}>
            Title
            <input
              value={title}
              maxLength={200}
              onChange={event => {
                setTitle(event.target.value);
              }}
              className={`${inputClass} text-base font-medium`}
            />
          </label>
          <label className={labelClass}>
            Address
            <span className="flex items-center gap-1">
              <span className="text-sm font-normal text-muted-foreground">/changelog/</span>
              <input
                value={slug}
                maxLength={80}
                aria-invalid={!isSlugValid}
                onChange={event => {
                  setSlug(event.target.value);
                }}
                className={`${inputClass} font-mono`}
              />
            </span>
          </label>
          <fieldset className="flex flex-wrap items-center gap-3">
            <legend className={`${labelClass} mb-1`}>Tags</legend>
            {Object.values(ChangelogTags).map(tag => (
              <label key={tag} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={tags.includes(tag)}
                  onChange={event => {
                    setTags(current => toggled(current, tag, event.target.checked));
                  }}
                />
                {tagLabels[tag]}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-4">
            <label className={labelClass}>
              Text (Markdown)
              <textarea
                value={body}
                rows={14}
                maxLength={50_000}
                placeholder="What changed, and how to use it."
                onChange={event => {
                  setBody(event.target.value);
                }}
                className={`${inputClass} h-auto min-h-64 font-mono text-xs leading-6`}
              />
            </label>
            <div aria-label="Preview" className="flex flex-col gap-3 rounded-xl border border-border p-4">
              <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
              <DocContent blocks={helpArticleBlocks(body)} />
            </div>
          </div>
          <PostPicker
            workspaceId={workspaceId}
            projectId={projectId}
            boardId={entry.boardId}
            postIds={postIds}
            onChange={setPostIds}
          />
          {update.error ? <p className="text-sm text-destructive">{errorMessage(update.error)}</p> : null}
          <span className="flex items-center gap-3">
            <Button
              type="submit"
              variant="outline"
              className="w-fit text-sm"
              disabled={!canSave}
              pending={update.isPending}>
              Save
            </Button>
            <span role="status" className="text-xs text-muted-foreground">
              {isDirty ? 'Unsaved changes' : 'All changes saved'}
            </span>
          </span>
        </form>
        <Actions
          workspaceId={workspaceId}
          projectId={projectId}
          entry={entry}
          saveFirst={save}
          isSaving={update.isPending}
        />
      </div>
    </div>
  );
}

export default function FeedbackChangelogEntry({ workspaceId, projectId, entryId }: Props) {
  const entryQuery = trpc.changelog.entry.useQuery({ workspaceId, projectId, entryId });
  if (entryQuery.isPending) {
    return <Spinner />;
  }
  if (entryQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(entryQuery.error)}</p>;
  }
  const { entry } = entryQuery.data;
  // A saved entry starts a fresh draft of the form.
  return (
    <Editor
      key={`${entry.id}:${entry.updatedAt.toISOString()}`}
      workspaceId={workspaceId}
      projectId={projectId}
      entry={entry}
    />
  );
}
