// A project's feedback boards (#175): create one, rename it or change its address, make it public
// or private, delete it, and edit its categories. A public board's page lives on the project's
// help center site (`/feedback/<slug>`), so the board links there when the project has one.
import { FEEDBACK_SLUG_PATTERN, FeedbackLimits } from '@mocco/common/feedback';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { errorMessage, inputClass, labelClass, Spinner } from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { feedbackSlugOf, publicBoardUrl, useHelpSiteSlug } from '@frontend/lib/feedback-console';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

interface Props {
  workspaceId: string;
  projectId: string;
}

interface BoardFields {
  id: string;
  slug: string;
  name: string;
  isPublic: boolean;
}

/** Create a board, or edit `board`'s name, address and visibility. */
export function BoardForm({ workspaceId, projectId, board }: Props & { board?: BoardFields }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [name, setName] = useState(board?.name ?? '');
  const [slug, setSlug] = useState(board?.slug ?? '');
  const [isSlugEdited, setIsSlugEdited] = useState(board !== undefined);
  const [isPublic, setIsPublic] = useState(board?.isPublic ?? true);
  const shownSlug = isSlugEdited ? slug : feedbackSlugOf(name);
  const create = trpc.feedback.createBoard.useMutation({
    onSuccess: async ({ board: created }) => {
      await utils.feedback.boards.invalidate();
      await router.push(Routes.projectFeedback(workspaceId, projectId, { board: created.slug }));
    },
  });
  const update = trpc.feedback.updateBoard.useMutation({
    onSuccess: async () => {
      await utils.feedback.boards.invalidate();
    },
  });
  const mutation = board === undefined ? create : update;
  // eslint-disable-next-line sonarjs/null-dereference -- name is a useState<string>, never null
  const trimmedName = name.trim();
  const isSlugValid = FEEDBACK_SLUG_PATTERN.test(shownSlug);
  const isUnchanged =
    board !== undefined && board.name === trimmedName && board.slug === shownSlug && board.isPublic === isPublic;

  return (
    <form
      aria-label={board === undefined ? 'New board' : `Board ${board.name}`}
      className="flex flex-col gap-3"
      onSubmit={event => {
        event.preventDefault();
        const input = { workspaceId, projectId, name: trimmedName, slug: shownSlug, isPublic };
        if (board === undefined) {
          create.mutate(input);
        } else {
          update.mutate({ ...input, boardId: board.id });
        }
      }}>
      <div className="flex flex-wrap gap-3">
        <label className={`${labelClass} min-w-48 flex-1`}>
          Name
          <input
            value={name}
            required
            maxLength={FeedbackLimits.nameMax}
            placeholder="Feature requests"
            onChange={event => {
              setName(event.target.value);
            }}
            className={inputClass}
          />
        </label>
        <label className={`${labelClass} min-w-40 flex-1`}>
          Address
          <span className="flex items-center gap-1">
            <span className="text-sm font-normal text-muted-foreground">/feedback/</span>
            <input
              value={shownSlug}
              required
              maxLength={40}
              aria-invalid={!isSlugValid}
              onChange={event => {
                setIsSlugEdited(true);
                setSlug(event.target.value);
              }}
              className={`${inputClass} font-mono`}
            />
          </span>
        </label>
      </div>
      {isSlugValid ? null : (
        <p className="text-xs text-destructive">Use lowercase letters, numbers and inner hyphens, up to 40.</p>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isPublic}
          onChange={event => {
            setIsPublic(event.target.checked);
          }}
        />
        Public: anyone can read it, and search engines index it
      </label>
      {mutation.error ? <p className="text-sm text-destructive">{errorMessage(mutation.error)}</p> : null}
      <Button
        type="submit"
        variant={board === undefined ? 'default' : 'outline'}
        className="w-fit text-sm"
        pending={mutation.isPending}
        disabled={trimmedName === '' || !isSlugValid || isUnchanged}>
        {board === undefined ? 'Create board' : 'Save'}
      </Button>
    </form>
  );
}

function Categories({ workspaceId, projectId, boardId }: Props & { boardId: string }) {
  const utils = trpc.useUtils();
  const boardQuery = trpc.feedback.board.useQuery({ workspaceId, projectId, boardId });
  const [newName, setNewName] = useState('');
  const refresh = async () => {
    await utils.feedback.board.invalidate({ workspaceId, projectId, boardId });
  };
  const create = trpc.feedback.createCategory.useMutation({
    onSuccess: async () => {
      setNewName('');
      await refresh();
    },
  });
  const rename = trpc.feedback.updateCategory.useMutation({ onSuccess: refresh });
  const remove = trpc.feedback.deleteCategory.useMutation({ onSuccess: refresh });
  const categories = boardQuery.data?.categories ?? [];
  // eslint-disable-next-line sonarjs/null-dereference -- newName is a useState<string>, never null
  const trimmedNew = newName.trim();
  const error = create.error ?? rename.error ?? remove.error;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Categories</h3>
      <p className="text-xs text-muted-foreground">
        Users pick one when they post, and the board and roadmap filter by them. Deleting a category keeps its posts,
        uncategorized.
      </p>
      {boardQuery.isPending ? <Spinner /> : null}
      <ul className="flex flex-col gap-2">
        {categories.map(category => (
          <li key={`${category.id}:${category.name}`} className="flex items-center gap-2">
            <input
              aria-label={`Name of ${category.slug}`}
              defaultValue={category.name}
              maxLength={FeedbackLimits.nameMax}
              onBlur={event => {
                const value = event.target.value.trim();
                if (value !== '' && value !== category.name) {
                  rename.mutate({
                    workspaceId,
                    projectId,
                    categoryId: category.id,
                    slug: category.slug,
                    name: value,
                    position: category.position,
                  });
                }
              }}
              className={`${inputClass} flex-1`}
            />
            <span className="w-32 shrink-0 truncate font-mono text-xs text-muted-foreground">{category.slug}</span>
            <Button
              variant="ghost"
              className="text-sm"
              pending={remove.isPending && remove.variables.categoryId === category.id}
              onClick={() => {
                remove.mutate({ workspaceId, projectId, categoryId: category.id });
              }}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <form
        aria-label="New category"
        className="flex items-center gap-2"
        onSubmit={event => {
          event.preventDefault();
          create.mutate({
            workspaceId,
            projectId,
            boardId,
            name: trimmedNew,
            slug: feedbackSlugOf(trimmedNew),
            position: categories.length,
          });
        }}>
        <input
          aria-label="New category"
          value={newName}
          maxLength={FeedbackLimits.nameMax}
          placeholder="New category, e.g. Mobile app"
          onChange={event => {
            setNewName(event.target.value);
          }}
          className={`${inputClass} flex-1`}
        />
        <Button
          type="submit"
          variant="outline"
          className="text-sm"
          pending={create.isPending}
          disabled={trimmedNew === ''}>
          Add category
        </Button>
      </form>
      {error ? <p className="text-sm text-destructive">{errorMessage(error)}</p> : null}
    </div>
  );
}

function DeleteBoard({ workspaceId, projectId, board }: Props & { board: BoardFields }) {
  const utils = trpc.useUtils();
  const [isConfirming, setIsConfirming] = useState(false);
  const remove = trpc.feedback.deleteBoard.useMutation({
    onSuccess: async () => {
      await utils.feedback.boards.invalidate();
    },
  });
  if (!isConfirming) {
    return (
      <Button
        variant="ghost"
        className="w-fit text-sm text-destructive"
        onClick={() => {
          setIsConfirming(true);
        }}>
        Delete board
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <p className="text-sm">
        Delete <span className="font-medium">{board.name}</span> with all its posts, votes and comments? Its public page
        stops working. This can&apos;t be undone.
      </p>
      <span className="flex gap-2">
        <Button
          variant="destructive"
          className="text-sm"
          pending={remove.isPending}
          onClick={() => {
            remove.mutate({ workspaceId, projectId, boardId: board.id });
          }}>
          Delete
        </Button>
        <Button
          variant="ghost"
          className="text-sm"
          onClick={() => {
            setIsConfirming(false);
          }}>
          Cancel
        </Button>
      </span>
      {remove.error ? <p className="text-sm text-destructive">{errorMessage(remove.error)}</p> : null}
    </div>
  );
}

export default function FeedbackBoards({ workspaceId, projectId }: Props) {
  const boardsQuery = trpc.feedback.boards.useQuery({ workspaceId, projectId });
  const siteSlug = useHelpSiteSlug(workspaceId, projectId);
  const [isAdding, setIsAdding] = useState(false);

  if (boardsQuery.isPending) {
    return <Spinner />;
  }
  if (boardsQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(boardsQuery.error)}</p>;
  }
  const { boards } = boardsQuery.data;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href={Routes.projectFeedback(workspaceId, projectId)}
          className="text-xs text-muted-foreground hover:text-foreground">
          ← Inbox
        </Link>
        <h2 className="text-sm font-medium">Boards</h2>
        {siteSlug === null ? (
          <p className="text-sm text-muted-foreground">
            Public boards are served on the project&apos;s help center site.{' '}
            <Link href={Routes.projectHelp(workspaceId, projectId)} className="underline underline-offset-2">
              Set up the help center
            </Link>{' '}
            to give them a page.
          </p>
        ) : null}
      </div>
      {boards.map(board => {
        const url = siteSlug === null || !board.isPublic ? null : publicBoardUrl(siteSlug, board.slug);
        return (
          <section key={board.id} className="flex flex-col gap-4 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">{board.name}</h3>
              {url === null ? null : (
                <a href={url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2">
                  {url.replace(/^https?:\/\//u, '')}
                </a>
              )}
            </div>
            <BoardForm
              // A saved board starts a fresh draft.
              key={`${board.slug}:${board.name}:${String(board.isPublic)}`}
              workspaceId={workspaceId}
              projectId={projectId}
              board={board}
            />
            <Categories workspaceId={workspaceId} projectId={projectId} boardId={board.id} />
            <DeleteBoard workspaceId={workspaceId} projectId={projectId} board={board} />
          </section>
        );
      })}
      {isAdding || boards.length === 0 ? (
        <section className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4">
          <h3 className="font-medium">New board</h3>
          <BoardForm workspaceId={workspaceId} projectId={projectId} />
        </section>
      ) : (
        <Button
          variant="outline"
          className="w-fit text-sm"
          onClick={() => {
            setIsAdding(true);
          }}>
          New board
        </Button>
      )}
    </div>
  );
}
