// One incident in the console (#148): post an update (offering only the status changes the
// lifecycle allows), its timeline, the components it affects, and its postmortem.
import { INCIDENT_TRANSITIONS, IncidentStatuses, incidentStatusSchema } from '@mocco/common/status';
import Link from 'next/link';
import { useState } from 'react';

import { errorMessage, inputClass, labelClass, Spinner } from '@frontend/components/notifications/notification-ui';
import AffectedComponentsPicker from '@frontend/components/status/affected-components';
import {
  ComponentStatusBadge,
  formatWhen,
  incidentSeverityLabels,
  IncidentStatusBadge,
  incidentStatusLabels,
  StatusTabs,
} from '@frontend/components/status/status-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { StatusOutputs } from '@frontend/components/status/status-ui';
import type { AffectedComponent, IncidentStatus } from '@mocco/common/status';

interface Props {
  workspaceId: string;
  projectId: string;
  incidentId: string;
}

type IncidentData = StatusOutputs['incident'];
type Component = StatusOutputs['page']['components'][number];

// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const isBlank = (value: string) => value.trim() === '';

/** The statuses an update may set: the current one (an update without a change) and its legal next steps. */
function offeredStatuses(current: IncidentStatus): IncidentStatus[] {
  return current === IncidentStatuses.resolved ? [] : [current, ...INCIDENT_TRANSITIONS[current]];
}

function PostUpdate({
  current,
  isPending,
  onPost,
}: {
  current: IncidentStatus;
  isPending: boolean;
  onPost: (status: IncidentStatus, body: string) => void;
}) {
  const [status, setStatus] = useState<IncidentStatus>(current);
  const [body, setBody] = useState('');
  return (
    <form
      aria-label="Post an update"
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
      onSubmit={event => {
        event.preventDefault();
        onPost(status, body);
      }}>
      <h2 className="text-sm font-medium">Post an update</h2>
      <label className={labelClass}>
        Status
        <select
          className={`${inputClass} w-fit`}
          value={status}
          onChange={event => {
            const parsed = incidentStatusSchema.safeParse(event.target.value);
            if (parsed.success) {
              setStatus(parsed.data);
            }
          }}>
          {offeredStatuses(current).map(value => (
            <option key={value} value={value}>
              {value === current ? `${incidentStatusLabels[value]} (no change)` : incidentStatusLabels[value]}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Message
        <textarea
          className={`${inputClass} h-24 py-1.5`}
          placeholder="We found the cause and are rolling out a fix."
          value={body}
          onChange={event => {
            setBody(event.target.value);
          }}
        />
      </label>
      <Button type="submit" className="w-fit text-sm" pending={isPending} disabled={isBlank(body)}>
        Post update
      </Button>
    </form>
  );
}

function Timeline({ updates }: { updates: IncidentData['updates'] }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Timeline</h2>
      <ol className="flex flex-col gap-4 border-l border-border pl-4">
        {updates.toReversed().map(update => (
          <li key={update.id} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <IncidentStatusBadge status={update.status} />
              <time className="text-xs text-muted-foreground" dateTime={update.createdAt.toISOString()}>
                {formatWhen(update.createdAt)}
              </time>
            </span>
            <p className="text-sm whitespace-pre-wrap">{update.bodyMd}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AffectedComponents({
  workspaceId,
  projectId,
  incidentId,
  affected,
  components,
}: Props & { affected: IncidentData['components']; components: readonly Component[] }) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<AffectedComponent[] | null>(null);
  const save = trpc.status.setIncidentComponents.useMutation({
    onSuccess: async () => {
      setDraft(null);
      await Promise.all([utils.status.incident.invalidate(), utils.status.page.invalidate()]);
    },
  });
  const nameOf = (componentId: string) => components.find(component => component.id === componentId)?.name;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Affected components</h2>
        {draft === null ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft(affected.map(entry => ({ componentId: entry.componentId, impact: entry.impact })));
            }}>
            Change
          </Button>
        ) : null}
      </div>
      {draft === null ? (
        <ul className="flex flex-col gap-1.5">
          {affected.length === 0 ? <li className="text-sm text-muted-foreground">None.</li> : null}
          {affected.map(entry => (
            <li key={entry.componentId} className="flex flex-wrap items-center gap-2 text-sm">
              {nameOf(entry.componentId) ?? 'Deleted component'}
              <ComponentStatusBadge status={entry.impact} />
            </li>
          ))}
        </ul>
      ) : (
        <form
          aria-label="Affected components"
          className="flex flex-col gap-3"
          onSubmit={event => {
            event.preventDefault();
            save.mutate({ workspaceId, projectId, incidentId, components: draft });
          }}>
          <AffectedComponentsPicker components={components} value={draft} onChange={setDraft} />
          {save.error ? <p className="text-sm text-destructive">{errorMessage(save.error)}</p> : null}
          <span className="flex gap-2">
            <Button type="submit" variant="outline" className="text-sm" pending={save.isPending}>
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="text-sm"
              onClick={() => {
                setDraft(null);
              }}>
              Cancel
            </Button>
          </span>
        </form>
      )}
    </section>
  );
}

function Postmortem({ workspaceId, projectId, incidentId, saved }: Props & { saved: string | null }) {
  const utils = trpc.useUtils();
  const [text, setText] = useState(saved ?? '');
  const save = trpc.status.setPostmortem.useMutation({
    onSuccess: async () => {
      await utils.status.incident.invalidate();
    },
  });
  return (
    <form
      aria-label="Postmortem"
      className="flex flex-col gap-3"
      onSubmit={event => {
        event.preventDefault();
        save.mutate({ workspaceId, projectId, incidentId, postmortem: isBlank(text) ? null : text });
      }}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Postmortem</h2>
        <p className="max-w-prose text-xs text-muted-foreground">
          What happened, why, and what changes so it doesn&apos;t happen again. Markdown. Leave it empty to remove it.
        </p>
      </div>
      <textarea
        aria-label="Postmortem text"
        className={`${inputClass} h-40 py-1.5 font-mono text-xs`}
        value={text}
        onChange={event => {
          setText(event.target.value);
        }}
      />
      {save.error ? <p className="text-sm text-destructive">{errorMessage(save.error)}</p> : null}
      <Button
        type="submit"
        variant="outline"
        className="w-fit text-sm"
        pending={save.isPending}
        disabled={text === (saved ?? '')}>
        Save postmortem
      </Button>
    </form>
  );
}

function IncidentBody({ workspaceId, projectId, incidentId, data }: Props & { data: IncidentData }) {
  const { incident, updates, components: affected } = data;
  const utils = trpc.useUtils();
  const pageQuery = trpc.status.page.useQuery({ workspaceId, projectId, pageId: incident.pageId });
  const refresh = async () => {
    await Promise.all([
      utils.status.incident.invalidate(),
      utils.status.incidents.invalidate(),
      utils.status.page.invalidate(),
    ]);
  };
  // Refused updates refresh too: the incident may have moved on in another tab.
  const post = trpc.status.postIncidentUpdate.useMutation({ onSuccess: refresh, onError: refresh });
  const scope = { workspaceId, projectId, incidentId };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={Routes.projectStatus(workspaceId, projectId, incident.pageId, { tab: StatusTabs.incidents })}
          className="w-fit text-xs text-muted-foreground transition hover:text-foreground">
          ← Incidents
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">{incident.title}</h2>
          <IncidentStatusBadge status={incident.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          {incidentSeverityLabels[incident.severity]} severity · started {formatWhen(incident.startedAt)}
          {incident.identifiedAt === null ? '' : ` · identified ${formatWhen(incident.identifiedAt)}`}
          {incident.resolvedAt === null ? '' : ` · resolved ${formatWhen(incident.resolvedAt)}`}
        </p>
      </div>
      {incident.status === IncidentStatuses.resolved ? (
        <p className="text-sm text-muted-foreground">This incident is resolved and closed to new updates.</p>
      ) : (
        // Remount after each posted update so the form starts empty, from the new status.
        <PostUpdate
          key={`${incident.status}:${updates.length}`}
          current={incident.status}
          isPending={post.isPending}
          onPost={(status, body) => {
            post.mutate({ ...scope, status, body });
          }}
        />
      )}
      {post.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(post.error)}
        </p>
      ) : null}
      <Timeline updates={updates} />
      <AffectedComponents {...scope} affected={affected} components={pageQuery.data?.components ?? []} />
      {/* Remount on a saved change so the editor starts from the saved text. */}
      <Postmortem
        key={incident.postmortemMd ?? ''}
        workspaceId={workspaceId}
        projectId={projectId}
        incidentId={incidentId}
        saved={incident.postmortemMd}
      />
    </div>
  );
}

export default function IncidentDetail({ workspaceId, projectId, incidentId }: Props) {
  const incidentQuery = trpc.status.incident.useQuery({ workspaceId, projectId, incidentId });
  if (incidentQuery.isPending) {
    return <Spinner />;
  }
  if (incidentQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(incidentQuery.error)}</p>;
  }
  return (
    <IncidentBody workspaceId={workspaceId} projectId={projectId} incidentId={incidentId} data={incidentQuery.data} />
  );
}
