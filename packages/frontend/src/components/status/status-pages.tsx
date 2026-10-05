// A project's status pages in the console (#148): create a page, pick the one shown
// (`?page=` in the URL), rename it or change its address, delete it, and manage what it
// reports on (PageComponents). The monitors view (#150) lists the project's monitors.
import { STATUS_PAGE_SLUG_PATTERN } from '@mocco/common/status';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useId, useState } from 'react';

import { errorMessage, inputClass, labelClass, Spinner } from '@frontend/components/notifications/notification-ui';
import Incidents from '@frontend/components/status/incidents';
import Maintenance from '@frontend/components/status/maintenance';
import Monitors from '@frontend/components/status/monitors';
import PageComponents from '@frontend/components/status/page-components';
import { slugFromTitle, StatusTabs } from '@frontend/components/status/status-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { StatusOutputs, StatusTab } from '@frontend/components/status/status-ui';

interface Props {
  workspaceId: string;
  projectId: string;
}

type Page = StatusOutputs['pages']['pages'][number];

const tabLabels: Readonly<Record<StatusTab, string>> = {
  [StatusTabs.components]: 'Components',
  [StatusTabs.incidents]: 'Incidents',
  [StatusTabs.maintenance]: 'Maintenance',
  [StatusTabs.monitors]: 'Monitors',
};

/** The tab in the URL, or components. */
function tabOf(value: unknown): StatusTab {
  return Object.values(StatusTabs).find(tab => tab === value) ?? StatusTabs.components;
}

// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const isBlank = (value: string) => value.trim() === '';

const SLUG_HINT = 'Lowercase letters, digits and inner hyphens, up to 40 characters.';

/** Title and address fields shared by creating and editing a page. */
function PageFields({
  title,
  slug,
  onTitle,
  onSlug,
}: {
  title: string;
  slug: string;
  onTitle: (value: string) => void;
  onSlug: (value: string) => void;
}) {
  const id = useId();
  const isSlugValid = STATUS_PAGE_SLUG_PATTERN.test(slug);
  return (
    <>
      <label className={labelClass} htmlFor={`${id}-title`}>
        Title
        <input
          id={`${id}-title`}
          className={inputClass}
          placeholder="Acme status"
          value={title}
          maxLength={120}
          onChange={event => {
            onTitle(event.target.value);
          }}
        />
      </label>
      <label className={labelClass} htmlFor={`${id}-slug`}>
        Address
        <input
          id={`${id}-slug`}
          className={`${inputClass} font-mono`}
          placeholder="acme"
          value={slug}
          maxLength={40}
          aria-invalid={slug !== '' && !isSlugValid}
          aria-describedby={`${id}-slug-hint`}
          onChange={event => {
            onSlug(event.target.value.toLowerCase());
          }}
        />
        <span id={`${id}-slug-hint`} className="font-normal">
          {SLUG_HINT} It becomes the public page&apos;s address, so it is unique across Mocco.
        </span>
      </label>
    </>
  );
}

function CreatePage({ workspaceId, projectId, onDone }: Props & { onDone?: () => void }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [title, setTitle] = useState('');
  const [editedSlug, setEditedSlug] = useState<string | null>(null);
  const slug = editedSlug ?? slugFromTitle(title);
  const create = trpc.status.createPage.useMutation({
    onSuccess: async ({ page }) => {
      await utils.status.pages.invalidate();
      await router.push(Routes.projectStatus(workspaceId, projectId, page.id));
      onDone?.();
    },
  });

  return (
    <form
      aria-label="New status page"
      className="flex max-w-xl flex-col gap-4"
      onSubmit={event => {
        event.preventDefault();
        create.mutate({ workspaceId, projectId, title, slug });
      }}>
      <PageFields title={title} slug={slug} onTitle={setTitle} onSlug={setEditedSlug} />
      {create.error ? <p className="text-sm text-destructive">{errorMessage(create.error)}</p> : null}
      <span className="flex flex-wrap gap-2">
        <Button
          type="submit"
          className="text-sm"
          pending={create.isPending}
          disabled={isBlank(title) || !STATUS_PAGE_SLUG_PATTERN.test(slug)}>
          Create page
        </Button>
        {onDone === undefined ? null : (
          <Button type="button" variant="ghost" className="text-sm" onClick={onDone}>
            Cancel
          </Button>
        )}
      </span>
    </form>
  );
}

/** Rename the page, change its address, or delete it with everything on it. */
function PageSettings({ workspaceId, projectId, page }: Props & { page: Page }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [title, setTitle] = useState(page.title);
  const [slug, setSlug] = useState(page.slug);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const update = trpc.status.updatePage.useMutation({
    onSuccess: async () => {
      await utils.status.pages.invalidate();
    },
  });
  const remove = trpc.status.deletePage.useMutation({
    onSuccess: async () => {
      await utils.status.pages.invalidate();
      await router.replace(Routes.projectStatus(workspaceId, projectId));
    },
  });
  const isChanged = title !== page.title || slug !== page.slug;

  return (
    <section className="flex flex-col gap-4 border-t border-border pt-6">
      <h2 className="text-sm font-medium">Page settings</h2>
      <form
        aria-label="Page settings"
        className="flex max-w-xl flex-col gap-4"
        onSubmit={event => {
          event.preventDefault();
          update.mutate({ workspaceId, projectId, pageId: page.id, title, slug });
        }}>
        <PageFields title={title} slug={slug} onTitle={setTitle} onSlug={setSlug} />
        {update.error ? <p className="text-sm text-destructive">{errorMessage(update.error)}</p> : null}
        <Button
          type="submit"
          variant="outline"
          className="w-fit text-sm"
          pending={update.isPending}
          disabled={!isChanged || isBlank(title) || !STATUS_PAGE_SLUG_PATTERN.test(slug)}>
          Save
        </Button>
      </form>
      <div className="flex flex-col gap-2">
        <p className="max-w-prose text-xs text-muted-foreground">
          Deleting the page deletes its components, incidents and maintenance windows.
        </p>
        {isConfirmingDelete ? (
          <span className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              className="text-sm"
              pending={remove.isPending}
              onClick={() => {
                remove.mutate({ workspaceId, projectId, pageId: page.id });
              }}>
              Delete {page.title}
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
        ) : (
          <Button
            variant="outline"
            className="w-fit text-sm"
            onClick={() => {
              setIsConfirmingDelete(true);
            }}>
            Delete page
          </Button>
        )}
        {remove.error ? <p className="text-sm text-destructive">{errorMessage(remove.error)}</p> : null}
      </div>
    </section>
  );
}

export default function StatusPages({ workspaceId, projectId }: Props) {
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);
  const pagesQuery = trpc.status.pages.useQuery({ workspaceId, projectId });
  if (pagesQuery.isPending) {
    return <Spinner />;
  }
  if (pagesQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(pagesQuery.error)}</p>;
  }
  const { pages } = pagesQuery.data;
  if (pages.length === 0) {
    return (
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Create a status page</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            A status page tells your users whether your service works. List the parts of your service as components,
            then report incidents and scheduled maintenance against them.
          </p>
        </div>
        <CreatePage workspaceId={workspaceId} projectId={projectId} />
      </section>
    );
  }
  const requested = typeof router.query.page === 'string' ? router.query.page : undefined;
  const page = pages.find(entry => entry.id === requested) ?? pages[0];
  if (page === undefined) {
    return null;
  }
  const tab = tabOf(router.query.tab);

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Status pages" className="flex flex-wrap items-center gap-1 border-b border-border">
        {pages.map(entry => (
          <Link
            key={entry.id}
            href={Routes.projectStatus(workspaceId, projectId, entry.id)}
            aria-current={entry.id === page.id ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              entry.id === page.id ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground'
            }`}>
            {entry.title}
          </Link>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => {
            setIsCreating(true);
          }}>
          New page
        </Button>
      </nav>
      {isCreating ? (
        <CreatePage
          workspaceId={workspaceId}
          projectId={projectId}
          onDone={() => {
            setIsCreating(false);
          }}
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Page views" className="flex gap-1 rounded-lg bg-muted p-0.5">
          {Object.values(StatusTabs).map(value => (
            <Link
              key={value}
              href={Routes.projectStatus(workspaceId, projectId, page.id, { tab: value })}
              aria-current={value === tab ? 'page' : undefined}
              className={`rounded-md px-3 py-1 text-sm ${
                value === tab ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}>
              {tabLabels[value]}
            </Link>
          ))}
        </nav>
        <p className="font-mono text-xs text-muted-foreground">{page.slug}</p>
      </div>
      {tab === StatusTabs.incidents ? (
        <Incidents workspaceId={workspaceId} projectId={projectId} pageId={page.id} />
      ) : null}
      {tab === StatusTabs.maintenance ? (
        <Maintenance workspaceId={workspaceId} projectId={projectId} pageId={page.id} />
      ) : null}
      {tab === StatusTabs.monitors ? <Monitors workspaceId={workspaceId} projectId={projectId} /> : null}
      {tab === StatusTabs.components ? (
        <>
          <PageComponents workspaceId={workspaceId} projectId={projectId} pageId={page.id} />
          {/* Remount on a page switch or a saved change so the form starts from the saved values. */}
          <PageSettings
            key={`${page.id}:${page.title}:${page.slug}`}
            workspaceId={workspaceId}
            projectId={projectId}
            page={page}
          />
        </>
      ) : null}
    </div>
  );
}
