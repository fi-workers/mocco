import { RunStates } from '@mocco/common/execution';
import { FlagApprovalSubjects } from '@mocco/common/flags';
import { ApprovalStates } from '@mocco/common/governance';
import { OtaApprovalSubjects } from '@mocco/common/ota';
import { OtaHostingApprovalSubjects } from '@mocco/common/ota-hosting';
import { Products } from '@mocco/common/project';
import Link from 'next/link';

import { Ago, Notice, Spinner, Tones } from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { auditActionLabels } from '@frontend/lib/audit-labels';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { ApprovalRequestDto } from '@mocco/common/governance';

interface Props {
  workspaceId: string;
}

/** Where a pending request lives, once its subject is traced back to a project. */
interface Place {
  context: string;
  href: string;
}

interface WaitingItem {
  key: string;
  product: string;
  title: string;
  context: string | null;
  by: string | null;
  at: Date;
  href: string | null;
}

interface Described {
  product: string;
  title: string;
  place: Place | null;
}

const RECENT_ACTIVITY = 6;

/** A failed section: what didn't load, and a way to try again. */
function LoadError({ what, message, retry }: { what: string; message: string; retry: () => void }) {
  return (
    <Notice tone={Tones.danger} title={`Couldn’t load ${what}`}>
      <span className="flex flex-wrap items-center gap-3">
        {message}
        <Button variant="outline" size="sm" onClick={retry}>
          Try again
        </Button>
      </span>
    </Notice>
  );
}

function placeOf(places: ReadonlyMap<string, Place>, id: string | null): Place | null {
  return id === null ? null : (places.get(id) ?? null);
}

function actionString(request: ApprovalRequestDto, key: string): string | null {
  const value = request.action[key];
  return typeof value === 'string' ? value : null;
}

/** The workspace's latest audit entries, in words. */
function RecentActivity({ workspaceId, nameOf }: { workspaceId: string; nameOf: (userId: string | null) => string }) {
  const auditQuery = trpc.audit.recent.useQuery({ workspaceId, limit: RECENT_ACTIVITY });
  const recent = auditQuery.data?.entries ?? [];
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium">Recent activity</h2>
        <Link href={Routes.workspaceAudit(workspaceId)} className="text-xs text-muted-foreground hover:text-foreground">
          Audit log →
        </Link>
      </div>
      {auditQuery.isError ? (
        <LoadError
          what="recent activity"
          message={auditQuery.error.message}
          retry={() => {
            fireAndForget(auditQuery.refetch());
          }}
        />
      ) : null}
      {auditQuery.isSuccess && recent.length === 0 ? (
        <p className="text-sm text-muted-foreground">No governed changes yet.</p>
      ) : null}
      {recent.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {recent.map(entry => (
            <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5">
              <span className="text-sm" title={entry.action}>
                {auditActionLabels[entry.action]}
              </span>
              <span className="text-xs text-muted-foreground">
                {nameOf(entry.actorUserId)} · <Ago date={entry.createdAt} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The workspace's projects, each linking to its overview. */
function ProjectList({ workspaceId }: { workspaceId: string }) {
  const projectsQuery = trpc.project.list.useQuery({ workspaceId });
  const projects = projectsQuery.data?.projects ?? [];
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium">Projects</h2>
        <Link
          href={Routes.workspaceProjects(workspaceId)}
          className="text-xs text-muted-foreground hover:text-foreground">
          All projects →
        </Link>
      </div>
      {projectsQuery.isError ? (
        <LoadError
          what="the projects"
          message={projectsQuery.error.message}
          retry={() => {
            fireAndForget(projectsQuery.refetch());
          }}
        />
      ) : null}
      {projectsQuery.isSuccess && projects.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No projects yet.{' '}
          <Link href={Routes.workspaceProjects(workspaceId)} className="underline underline-offset-2">
            Create one
          </Link>{' '}
          for each product you ship.
        </p>
      ) : null}
      {projects.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {projects.map(project => (
            <li key={project.id}>
              <Link
                href={Routes.project(workspaceId, project.id)}
                className="flex flex-col gap-0.5 rounded-xl border border-border px-4 py-3 transition hover:bg-muted">
                <span className="text-sm font-medium">{project.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{project.handle}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// The workspace's Home: what is waiting for the team's approval across products, the
// latest governed changes, and the projects. Approval requests carry no project, so
// their subjects (a flag environment, a store app, an OTA channel) are traced back
// through the projects' own lists — fetched only while something is pending.
export default function WorkspaceHome({ workspaceId }: Props) {
  const projectsQuery = trpc.project.list.useQuery({ workspaceId });
  const productsQuery = trpc.product.list.useQuery({ workspaceId });
  const approvalsQuery = trpc.approval.list.useQuery({ workspaceId, state: ApprovalStates.pending });
  // Deploys paused at a gate wait for approval too; they live on runs, not approval requests.
  const gatesQuery = trpc.run.list.useQuery({ workspaceId, state: RunStates.awaitingGate, limit: 20 });
  const membersQuery = trpc.workspace.members.useQuery({ workspaceId });

  const projects = projectsQuery.data?.projects ?? [];
  const enabled = productsQuery.data?.products ?? [];
  const pending = approvalsQuery.data?.requests ?? [];
  const hasPending = pending.length > 0;
  const flagProjects = hasPending && enabled.includes(Products.flags) ? projects : [];
  const otaProjects = hasPending && enabled.includes(Products.ota) ? projects : [];

  const environmentQueries = trpc.useQueries(t =>
    flagProjects.map(project => t.flags.environments({ workspaceId, projectId: project.id })),
  );
  const storeAppQueries = trpc.useQueries(t =>
    otaProjects.map(project => t.project.listApps({ workspaceId, projectId: project.id })),
  );
  const otaAppQueries = trpc.useQueries(t =>
    otaProjects.map(project => t.ota.hosting.apps.list({ workspaceId, projectId: project.id })),
  );
  const otaApps = otaAppQueries.flatMap((query, index) =>
    (query.data?.apps ?? []).map(app => ({ app, project: otaProjects[index] })),
  );
  const channelQueries = trpc.useQueries(t =>
    otaApps.flatMap(({ app, project }) =>
      project === undefined ? [] : [t.ota.hosting.channels.list({ workspaceId, projectId: project.id, appId: app.id })],
    ),
  );

  const environments = new Map<string, Place>(
    environmentQueries.flatMap((query, index) => {
      const project = flagProjects[index];
      return project === undefined
        ? []
        : (query.data?.environments ?? []).map(environment => [
            environment.id,
            {
              context: `${project.name} · ${environment.name}`,
              href: Routes.projectFlags(workspaceId, project.id, environment.id),
            },
          ]);
    }),
  );
  const storeApps = new Map<string, Place>(
    storeAppQueries.flatMap((query, index) => {
      const project = otaProjects[index];
      return project === undefined
        ? []
        : (query.data?.apps ?? []).map(app => [
            app.id,
            { context: `${project.name} · ${app.name}`, href: Routes.projectOta(workspaceId, project.id, app.id) },
          ]);
    }),
  );
  const channels = new Map<string, Place>(
    channelQueries.flatMap((query, index) => {
      const owner = otaApps[index];
      const project = owner?.project;
      return owner === undefined || project === undefined
        ? []
        : (query.data?.channels ?? []).map(channel => [
            channel.id,
            {
              context: `${project.name} · ${channel.name}`,
              href: Routes.projectOtaChannel(workspaceId, project.id, owner.app.id, channel.id),
            },
          ]);
    }),
  );

  const describe = (request: ApprovalRequestDto): Described => {
    switch (request.subjectType) {
      case FlagApprovalSubjects.changeset: {
        return {
          product: 'Flags',
          title: 'Flag change in a protected environment',
          place: placeOf(environments, actionString(request, 'environmentId')),
        };
      }
      case FlagApprovalSubjects.changeGate: {
        return {
          product: 'Flags',
          title: 'New approval rule for an environment',
          place: placeOf(environments, request.subjectId),
        };
      }
      case FlagApprovalSubjects.kill: {
        return {
          product: 'Flags',
          title: 'Review of a kill switch',
          place: placeOf(environments, actionString(request, 'environmentId')),
        };
      }
      case OtaApprovalSubjects.versionPolicy: {
        return {
          product: 'OTA',
          title: 'Minimum or recommended app version',
          place: storeApps.get(request.subjectId) ?? null,
        };
      }
      case OtaHostingApprovalSubjects.channelPolicy: {
        return {
          product: 'OTA',
          title: 'New approval rule for a channel',
          place: channels.get(request.subjectId) ?? null,
        };
      }
      case OtaHostingApprovalSubjects.channelChange: {
        return {
          product: 'OTA',
          title: 'Release change on a protected channel',
          place: channels.get(request.subjectId) ?? null,
        };
      }
      default: {
        return { product: 'Other', title: request.subjectType, place: null };
      }
    }
  };

  const names = new Map((membersQuery.data?.members ?? []).map(member => [member.userId, member.user.name]));
  const nameOf = (userId: string | null) => (userId === null ? 'Mocco' : (names.get(userId) ?? 'Former member'));

  // Everything waiting for someone's approval, newest first: deploys paused at a gate
  // and the approval requests of every other product.
  const waiting: WaitingItem[] = [
    ...(gatesQuery.data?.runs ?? []).map(run => ({
      key: `run-${run.id}`,
      product: 'Deploy',
      title: 'Deploy waiting at a gate',
      context: `${run.repo} · ${run.branch} · ${run.sha.slice(0, 7)}`,
      by: null,
      at: run.createdAt,
      href: Routes.workspaceRun(workspaceId, run.id),
    })),
    ...pending.map(request => {
      const described = describe(request);
      return {
        key: request.id,
        product: described.product,
        title: described.title,
        context: described.place?.context ?? null,
        by: nameOf(request.requestedByUserId),
        at: request.createdAt,
        href: described.place?.href ?? null,
      };
    }),
  ].toSorted((a, b) => b.at.getTime() - a.at.getTime());
  // A request whose screen couldn't be traced because a lookup failed, as opposed to
  // one that simply has no screen to link to.
  const haveLookupsFailed = [...environmentQueries, ...storeAppQueries, ...otaAppQueries, ...channelQueries].some(
    query => query.isError,
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Home</h1>
        <p className="text-sm text-muted-foreground">
          What is waiting for your team’s approval across products, and what changed recently.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Waiting for approval</h2>
        {approvalsQuery.isPending || gatesQuery.isPending ? <Spinner /> : null}
        {gatesQuery.isError ? (
          <LoadError
            what="the deploys waiting at a gate"
            message={gatesQuery.error.message}
            retry={() => {
              fireAndForget(gatesQuery.refetch());
            }}
          />
        ) : null}
        {approvalsQuery.isError ? (
          <LoadError
            what="the approvals"
            message={approvalsQuery.error.message}
            retry={() => {
              fireAndForget(approvalsQuery.refetch());
            }}
          />
        ) : null}
        {haveLookupsFailed ? (
          <p className="text-xs text-muted-foreground">
            Some approvals couldn’t be linked to their screen; reload the page to try again.
          </p>
        ) : null}
        {approvalsQuery.isSuccess && gatesQuery.isSuccess && waiting.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Nothing is waiting for approval.
          </p>
        ) : null}
        {waiting.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {waiting.map(item => {
              const body = (
                <>
                  <span className="w-12 shrink-0">
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium">{item.product}</span>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-medium">{item.title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {item.context === null ? null : `${item.context} · `}
                      {item.by === null ? null : `${item.by} · `}
                      <Ago date={item.at} />
                    </span>
                  </span>
                </>
              );
              return (
                <li key={item.key}>
                  {item.href === null ? (
                    <div className="flex items-center gap-3 px-4 py-3">{body}</div>
                  ) : (
                    <Link href={item.href} className="flex items-center gap-3 px-4 py-3 transition hover:bg-muted">
                      {body}
                      <span aria-hidden="true" className="text-muted-foreground">
                        →
                      </span>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      <RecentActivity workspaceId={workspaceId} nameOf={nameOf} />

      <ProjectList workspaceId={workspaceId} />
    </div>
  );
}
