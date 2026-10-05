// The runs linked to an incident (#154): the releases Mocco suggests around its start, with their
// score, and the runs a person linked. Link any recent run of the workspace, unlink one, or
// recompute the suggestions (a person's links are kept).
import { IncidentRunRelations, manualIncidentRunRelationSchema } from '@mocco/common/status';
import Link from 'next/link';
import { useState } from 'react';

import {
  errorMessage,
  inputClass,
  labelClass,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { formatWhen } from '@frontend/components/status/status-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { Tone } from '@frontend/components/notifications/notification-ui';
import type { StatusOutputs } from '@frontend/components/status/status-ui';
import type { IncidentRunRelation } from '@mocco/common/status';

interface Props {
  workspaceId: string;
  projectId: string;
  incidentId: string;
}

type LinkedRun = StatusOutputs['incidentRuns']['runs'][number];

export const incidentRunRelationLabels: Readonly<Record<IncidentRunRelation, string>> = {
  [IncidentRunRelations.suspected]: 'Suspected',
  [IncidentRunRelations.beforeWindow]: 'In the window',
  [IncidentRunRelations.fix]: 'Fix',
  [IncidentRunRelations.manual]: 'Linked by hand',
};

const relationTones: Readonly<Record<IncidentRunRelation, Tone>> = {
  [IncidentRunRelations.suspected]: Tones.danger,
  [IncidentRunRelations.beforeWindow]: Tones.neutral,
  [IncidentRunRelations.fix]: Tones.ok,
  [IncidentRunRelations.manual]: Tones.warn,
};

export function IncidentRunRelationBadge({ relation }: { relation: IncidentRunRelation }) {
  return <StatusBadge tone={relationTones[relation]}>{incidentRunRelationLabels[relation]}</StatusBadge>;
}

/** The relations a person picks when linking a run. */
type ManualRelation = typeof IncidentRunRelations.manual | typeof IncidentRunRelations.fix;

// eslint-disable-next-line sonarjs/null-dereference -- sha is a string, never null
const shortSha = (sha: string) => sha.slice(0, 7);

function LinkedRunRow({
  workspaceId,
  link,
  isPending,
  onUnlink,
}: {
  workspaceId: string;
  link: LinkedRun;
  isPending: boolean;
  onUnlink: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
      <span className="flex flex-wrap items-center gap-2 text-sm">
        <IncidentRunRelationBadge relation={link.relation} />
        <Link
          href={Routes.workspaceRun(workspaceId, link.runId)}
          className="font-medium underline-offset-2 hover:underline">
          {link.run === null ? 'Deleted run' : `${link.run.repoFullName}@${shortSha(link.run.commitSha)}`}
        </Link>
        {link.run?.finishedAt ? (
          <span className="text-xs text-muted-foreground">
            {link.run.state} · finished {formatWhen(link.run.finishedAt)}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {link.score === null ? 'linked by a person' : `score ${link.score.toFixed(2)}`}
        </span>
      </span>
      <Button variant="ghost" size="sm" pending={isPending} onClick={onUnlink}>
        Unlink
      </Button>
    </li>
  );
}

function LinkRunForm({
  workspaceId,
  linkedIds,
  isPending,
  onLink,
}: {
  workspaceId: string;
  linkedIds: ReadonlySet<string>;
  isPending: boolean;
  onLink: (runId: string, relation: ManualRelation) => void;
}) {
  const runsQuery = trpc.run.list.useQuery({ workspaceId, limit: 50 });
  const [runId, setRunId] = useState('');
  const [relation, setRelation] = useState<ManualRelation>(IncidentRunRelations.manual);
  const candidates = (runsQuery.data?.runs ?? []).filter(run => !linkedIds.has(run.id));
  return (
    <form
      aria-label="Link a run"
      className="flex flex-wrap items-end gap-2"
      onSubmit={event => {
        event.preventDefault();
        onLink(runId, relation);
        setRunId('');
      }}>
      <label className={labelClass}>
        Run
        <select
          className={`${inputClass} max-w-80`}
          value={runId}
          onChange={event => {
            setRunId(event.target.value);
          }}>
          <option value="">Pick a recent run…</option>
          {candidates.map(run => (
            <option key={run.id} value={run.id}>
              {`${run.repo}@${shortSha(run.sha)} · ${run.state} · ${formatWhen(run.createdAt)}`}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        As
        <select
          className={`${inputClass} w-fit`}
          value={relation}
          onChange={event => {
            const parsed = manualIncidentRunRelationSchema.safeParse(event.target.value);
            if (parsed.success) {
              setRelation(parsed.data);
            }
          }}>
          <option value={IncidentRunRelations.manual}>Related</option>
          <option value={IncidentRunRelations.fix}>Fix</option>
        </select>
      </label>
      <Button type="submit" variant="outline" className="text-sm" pending={isPending} disabled={runId === ''}>
        Link run
      </Button>
    </form>
  );
}

export default function RecentDeploys({ workspaceId, projectId, incidentId }: Props) {
  const scope = { workspaceId, projectId, incidentId };
  const utils = trpc.useUtils();
  const runsQuery = trpc.status.incidentRuns.useQuery(scope);
  const refresh = async () => {
    await utils.status.incidentRuns.invalidate(scope);
  };
  const link = trpc.status.linkRun.useMutation({ onSuccess: refresh });
  const unlink = trpc.status.unlinkRun.useMutation({ onSuccess: refresh });
  const recompute = trpc.status.correlateIncident.useMutation({ onSuccess: refresh });
  const runs = runsQuery.data?.runs ?? [];
  const mutationError = link.error ?? unlink.error ?? recompute.error;

  return (
    <section aria-label="Recent deploys" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Recent deploys</h2>
          <p className="max-w-prose text-xs text-muted-foreground">
            Releases from two hours before the incident started to five minutes after, closest first, and the runs
            linked by hand.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          pending={recompute.isPending}
          onClick={() => {
            recompute.mutate(scope);
          }}>
          Recompute
        </Button>
      </div>
      {runsQuery.error ? <p className="text-sm text-destructive">{errorMessage(runsQuery.error)}</p> : null}
      {runsQuery.isSuccess && runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No release finished near the start of this incident.</p>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {runs.map(row => (
          <LinkedRunRow
            key={row.runId}
            workspaceId={workspaceId}
            link={row}
            isPending={unlink.isPending && unlink.variables.runId === row.runId}
            onUnlink={() => {
              unlink.mutate({ ...scope, runId: row.runId });
            }}
          />
        ))}
      </ul>
      <LinkRunForm
        workspaceId={workspaceId}
        linkedIds={new Set(runs.map(row => row.runId))}
        isPending={link.isPending}
        onLink={(runId, relation) => {
          link.mutate({ ...scope, runId, relation });
        }}
      />
      {mutationError ? <p className="text-sm text-destructive">{errorMessage(mutationError)}</p> : null}
    </section>
  );
}
