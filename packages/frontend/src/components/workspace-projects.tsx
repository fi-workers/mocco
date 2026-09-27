import { zodResolver } from '@hookform/resolvers/zod';
import { projectCreateInputSchema } from '@mocco/common/project';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useForm } from 'react-hook-form';

import {
  inputClass,
  labelClass,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { ProjectCreateInput } from '@mocco/common/project';

interface Props {
  workspaceId: string;
}

/** A url-safe handle suggestion from a project name ("Acme Mobile" → "acme-mobile"). */
function handleFrom(name: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- false positive: name is a required string
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-')
    .slice(0, 40);
}

function CreateProjectForm({ workspaceId }: Props) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { mutateAsync: createProject } = trpc.project.create.useMutation();
  const {
    register,
    handleSubmit,
    setValue,
    getFieldState,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ProjectCreateInput>({
    resolver: zodResolver(projectCreateInputSchema),
    defaultValues: { name: '', handle: '' },
  });

  const submit = handleSubmit(async values => {
    try {
      const { project } = await createProject({ workspaceId, ...values });
      await utils.project.list.invalidate({ workspaceId });
      await router.push(Routes.project(workspaceId, project.id));
    } catch (error) {
      setError('root', { message: (error as Error).message });
    }
  });

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
      aria-label="New project">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Name
          <input
            {...register('name', {
              onChange: (event: { target: { value: string } }) => {
                // Suggest the handle from the name until the user edits the handle.
                if (!getFieldState('handle').isDirty) {
                  setValue('handle', handleFrom(event.target.value));
                }
              },
            })}
            maxLength={80}
            placeholder="Acme mobile"
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Handle
          <input
            {...register('handle')}
            maxLength={40}
            placeholder="acme-mobile"
            className={`${inputClass} font-mono`}
          />
        </label>
      </div>
      {errors.name ? <p className="text-sm text-destructive">{errors.name.message}</p> : null}
      {errors.handle ? (
        <p className="text-sm text-destructive">Lowercase letters, digits and inner hyphens, up to 40 characters.</p>
      ) : null}
      {errors.root ? <p className="text-sm text-destructive">{errors.root.message}</p> : null}
      <Button type="submit" pending={isSubmitting} className="w-fit text-sm">
        Create project
      </Button>
    </form>
  );
}

// Workspace → Projects: the products the team ships. Each product line after deploy
// governance (OTA, flags, …) works per project. Archived projects show when
// `?archived=1` is in the URL.
export default function WorkspaceProjects({ workspaceId }: Props) {
  const router = useRouter();
  const isArchivedShown = router.query.archived === '1';
  const listQuery = trpc.project.list.useQuery({ workspaceId, includeArchived: isArchivedShown });
  const projects = listQuery.data?.projects ?? [];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
        <p className="text-sm text-muted-foreground">
          A project is a product your team ships, with its apps and repos. OTA, feature flags and the other products
          work per project.
        </p>
      </div>

      <CreateProjectForm workspaceId={workspaceId} />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">{isArchivedShown ? 'All projects' : 'Active projects'}</h2>
          <Link
            href={{ pathname: Routes.workspaceProjects(workspaceId), query: isArchivedShown ? {} : { archived: '1' } }}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
            {isArchivedShown ? 'Hide archived' : 'Show archived'}
          </Link>
        </div>
        {listQuery.isPending ? <Spinner /> : null}
        {!listQuery.isPending && projects.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No projects yet. Create one above.
          </p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {projects.map(project => (
            <li key={project.id}>
              <Link
                href={Routes.project(workspaceId, project.id)}
                className="flex items-center justify-between rounded-xl border border-border px-4 py-3 transition hover:bg-muted">
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{project.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{project.handle}</span>
                </span>
                {project.archivedAt ? <StatusBadge tone={Tones.neutral}>Archived</StatusBadge> : null}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
