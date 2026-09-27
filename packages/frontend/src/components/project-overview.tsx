import { AppPlatforms } from '@mocco/common/project';
import { useState } from 'react';

import {
  errorMessage,
  inputClass,
  labelClass,
  Notice,
  Spinner,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { trpc } from '@frontend/lib/trpc';

import type { AppPlatform } from '@mocco/common/project';

interface Props {
  workspaceId: string;
  projectId: string;
}

const platformLabels: Record<AppPlatform, string> = {
  [AppPlatforms.ios]: 'iOS',
  [AppPlatforms.android]: 'Android',
  [AppPlatforms.web]: 'Web',
  [AppPlatforms.reactNative]: 'React Native',
  [AppPlatforms.server]: 'Server',
};
const bundleLabels: Partial<Record<AppPlatform, string>> = {
  [AppPlatforms.ios]: 'Bundle ID',
  [AppPlatforms.android]: 'Application ID',
};
const storeLabels: Partial<Record<AppPlatform, string>> = {
  [AppPlatforms.ios]: 'App Store ID (numeric)',
  [AppPlatforms.android]: 'Play package (if different)',
};

function AddAppForm({ workspaceId, projectId, onDone }: Props & { onDone: () => void }) {
  const utils = trpc.useUtils();
  const [platform, setPlatform] = useState<AppPlatform>(AppPlatforms.ios);
  const [name, setName] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [storeAppId, setStoreAppId] = useState('');
  const appAddition = trpc.project.addApp.useMutation({
    onSuccess: async () => {
      await utils.project.listApps.invalidate({ workspaceId, projectId });
      onDone();
    },
  });
  // eslint-disable-next-line sonarjs/null-dereference -- name is a useState<string>, never null
  const trimmedName = name.trim();
  // eslint-disable-next-line sonarjs/null-dereference -- bundleId is a useState<string>, never null
  const trimmedBundleId = bundleId.trim();
  // eslint-disable-next-line sonarjs/null-dereference -- storeAppId is a useState<string>, never null
  const trimmedStoreAppId = storeAppId.trim();
  const bundleLabel = bundleLabels[platform];
  const storeLabel = storeLabels[platform];

  return (
    <form
      aria-label="Add app"
      className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3"
      onSubmit={event => {
        event.preventDefault();
        appAddition.mutate({
          workspaceId,
          projectId,
          platform,
          name: trimmedName,
          ...(bundleLabel && trimmedBundleId !== '' && { bundleId: trimmedBundleId }),
          ...(storeLabel && trimmedStoreAppId !== '' && { storeAppId: trimmedStoreAppId }),
        });
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Platform
          <select
            value={platform}
            onChange={event => {
              setPlatform(event.target.value as AppPlatform);
            }}
            className={inputClass}>
            {Object.values(AppPlatforms).map(value => (
              <option key={value} value={value}>
                {platformLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Name
          <input
            required
            maxLength={80}
            value={name}
            placeholder="Acme iOS"
            onChange={event => {
              setName(event.target.value);
            }}
            className={inputClass}
          />
        </label>
        {bundleLabel ? (
          <label className={labelClass}>
            {bundleLabel}
            <input
              value={bundleId}
              placeholder="com.acme.app"
              onChange={event => {
                setBundleId(event.target.value);
              }}
              className={`${inputClass} font-mono`}
            />
          </label>
        ) : null}
        {storeLabel ? (
          <label className={labelClass}>
            {storeLabel}
            <input
              value={storeAppId}
              onChange={event => {
                setStoreAppId(event.target.value);
              }}
              className={`${inputClass} font-mono`}
            />
          </label>
        ) : null}
      </div>
      {appAddition.error ? <p className="text-sm text-destructive">{errorMessage(appAddition.error)}</p> : null}
      <Button type="submit" pending={appAddition.isPending} disabled={trimmedName === ''} className="w-fit text-sm">
        Add app
      </Button>
    </form>
  );
}

function AppsSection({ workspaceId, projectId, isArchived }: Props & { isArchived: boolean }) {
  const utils = trpc.useUtils();
  const appsQuery = trpc.project.listApps.useQuery({ workspaceId, projectId });
  const appRemoval = trpc.project.removeApp.useMutation({
    onSuccess: async () => {
      await utils.project.listApps.invalidate({ workspaceId, projectId });
    },
  });
  const [isAdding, setIsAdding] = useState(false);
  const apps = appsQuery.data?.apps ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">Apps</h2>
          <p className="text-xs text-muted-foreground">
            One per build target. Store apps (iOS, Android) get force update.
          </p>
        </div>
        {isArchived ? null : (
          <Button
            variant={isAdding ? 'ghost' : 'outline'}
            className="text-sm"
            onClick={() => {
              setIsAdding(value => !value);
            }}>
            {isAdding ? 'Close' : 'Add app'}
          </Button>
        )}
      </div>
      {isAdding ? (
        <AddAppForm
          workspaceId={workspaceId}
          projectId={projectId}
          onDone={() => {
            setIsAdding(false);
          }}
        />
      ) : null}
      {appsQuery.isPending ? <Spinner /> : null}
      {!appsQuery.isPending && apps.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No apps yet.
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {apps.map(app => (
          <li
            key={app.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">
                {app.name} <span className="text-xs text-muted-foreground">· {platformLabels[app.platform]}</span>
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {[app.bundleId, app.storeAppId].filter(Boolean).join(' · ') || '—'}
              </span>
            </span>
            {isArchived ? null : (
              <Button
                variant="ghost"
                className="text-sm"
                pending={appRemoval.isPending && appRemoval.variables?.appId === app.id}
                onClick={() => {
                  appRemoval.mutate({ workspaceId, projectId, appId: app.id });
                }}>
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {appRemoval.error ? <p className="text-sm text-destructive">{errorMessage(appRemoval.error)}</p> : null}
    </section>
  );
}

function ReposSection({ workspaceId, projectId, isArchived }: Props & { isArchived: boolean }) {
  const utils = trpc.useUtils();
  const linksQuery = trpc.project.listRepos.useQuery({ workspaceId, projectId });
  // Repos come from the GitHub integration; without it there is nothing to link.
  const reposQuery = trpc.integration.repos.useQuery({ workspaceId }, { retry: false });
  const onSuccess = async () => {
    await utils.project.listRepos.invalidate({ workspaceId, projectId });
  };
  const link = trpc.project.linkRepo.useMutation({ onSuccess });
  const unlink = trpc.project.unlinkRepo.useMutation({ onSuccess });
  const [selected, setSelected] = useState('');
  const repos = reposQuery.data?.repos ?? [];
  const linkedIds = new Set((linksQuery.data?.links ?? []).map(entry => entry.repoId));
  const nameOf = (repoId: string) => {
    const repo = repos.find(candidate => candidate.id === repoId);
    return repo ? `${repo.owner}/${repo.name}` : repoId;
  };
  const linkable = repos.filter(repo => !linkedIds.has(repo.id));

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">Repositories</h2>
        <p className="text-xs text-muted-foreground">
          The repos this project ships from. Their deploy runs count as this project’s releases.
        </p>
      </div>
      {reposQuery.isError ? (
        <Notice tone={Tones.neutral} title="No repositories to link">
          Connect GitHub on the workspace overview to register repositories first.
        </Notice>
      ) : null}
      <ul className="flex flex-col gap-2">
        {[...linkedIds].map(repoId => (
          <li key={repoId} className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
            <span className="font-mono text-sm">{nameOf(repoId)}</span>
            {isArchived ? null : (
              <Button
                variant="ghost"
                className="text-sm"
                pending={unlink.isPending && unlink.variables?.repoId === repoId}
                onClick={() => {
                  unlink.mutate({ workspaceId, projectId, repoId });
                }}>
                Unlink
              </Button>
            )}
          </li>
        ))}
      </ul>
      {isArchived || linkable.length === 0 ? null : (
        <form
          aria-label="Link a repository"
          className="flex flex-wrap items-end gap-2"
          onSubmit={event => {
            event.preventDefault();
            link.mutate({ workspaceId, projectId, repoId: selected });
            setSelected('');
          }}>
          <label className={labelClass}>
            Repository
            <select
              value={selected}
              onChange={event => {
                setSelected(event.target.value);
              }}
              className={inputClass}>
              <option value="">Choose…</option>
              {linkable.map(repo => (
                <option key={repo.id} value={repo.id}>
                  {repo.owner}/{repo.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="submit"
            variant="outline"
            disabled={selected === ''}
            pending={link.isPending}
            className="text-sm">
            Link
          </Button>
        </form>
      )}
      {link.error ? <p className="text-sm text-destructive">{errorMessage(link.error)}</p> : null}
    </section>
  );
}

// A project's home: its apps and linked repos, and archiving. An archived project is
// read-only (the API refuses changes), so its edit controls are hidden.
export default function ProjectOverview({ workspaceId, projectId }: Props) {
  const utils = trpc.useUtils();
  const projectQuery = trpc.project.get.useQuery({ workspaceId, projectId }, { retry: false });
  const archiving = trpc.project.setArchived.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.project.get.invalidate({ workspaceId, projectId }), utils.project.list.invalidate()]);
    },
  });
  const project = projectQuery.data?.project;
  if (!project) {
    return <Spinner />;
  }
  const isArchived = project.archivedAt !== null;

  return (
    <div className="flex flex-col gap-8">
      {isArchived ? (
        <Notice tone={Tones.warn} title="This project is archived">
          It is read-only and hidden from the project list. Unarchive it to make changes.
        </Notice>
      ) : null}
      <AppsSection workspaceId={workspaceId} projectId={projectId} isArchived={isArchived} />
      <ReposSection workspaceId={workspaceId} projectId={projectId} isArchived={isArchived} />
      <section className="flex flex-col gap-2 rounded-xl border border-border p-4">
        <h2 className="text-sm font-medium">{isArchived ? 'Unarchive project' : 'Archive project'}</h2>
        <p className="text-xs text-muted-foreground">
          {isArchived
            ? 'Bring the project back to the list and allow changes again.'
            : 'Hide the project and make it read-only. Nothing is deleted.'}
        </p>
        <Button
          variant="outline"
          className="w-fit text-sm"
          pending={archiving.isPending}
          onClick={() => {
            archiving.mutate({ workspaceId, projectId, archived: !isArchived });
          }}>
          {isArchived ? 'Unarchive' : 'Archive'}
        </Button>
      </section>
    </div>
  );
}
