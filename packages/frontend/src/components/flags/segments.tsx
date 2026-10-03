// An environment's segments (#140): named groups of targeting keys and attribute rules
// that flag rules refer to. Editing one is a changeset on that environment.
import { SEGMENT_KEY_PATTERN } from '@mocco/common/flags';
import { useState } from 'react';

import { draftId, emptyAttributeClause, toAttributeClause } from '@frontend/components/flags/rule-drafts';
import { ClauseRow } from '@frontend/components/flags/rule-editor';
import {
  errorMessage,
  inputClass,
  labelClass,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { trpc } from '@frontend/lib/trpc';

import type { ClauseDraft } from '@frontend/components/flags/rule-drafts';
import type { FlagEnvironmentDto, FlagSegmentDto } from '@mocco/common/flags';

interface Props {
  workspaceId: string;
  projectId: string;
  environment: FlagEnvironmentDto;
}

interface GroupDraft {
  id: string;
  clauses: ClauseDraft[];
}

/** Keys typed one per line or comma-separated. */
/* eslint-disable sonarjs/null-dereference -- textarea values and split() parts are strings */
const keysOf = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\n,]/u)
      .map(key => key.trim())
      .filter(key => key !== ''),
  ),
];
/* eslint-enable sonarjs/null-dereference */

/** One OR group of a segment: attribute conditions that must all match. */
function GroupEditor({
  group,
  position,
  onChange,
}: {
  group: GroupDraft;
  position: number;
  /** null removes the group (its last condition was removed). */
  onChange: (clauses: ClauseDraft[] | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border p-2" aria-label={`Group ${position}`}>
      {group.clauses.map(clause => (
        <ClauseRow
          key={clause.id}
          draft={clause}
          segmentKeys={null}
          onChange={next => {
            onChange(group.clauses.map(other => (other.id === clause.id ? next : other)));
          }}
          onRemove={() => {
            const rest = group.clauses.filter(other => other.id !== clause.id);
            onChange(rest.length === 0 ? null : rest);
          }}
        />
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="w-fit text-xs"
        onClick={() => {
          onChange([...group.clauses, emptyAttributeClause()]);
        }}>
        + Condition
      </Button>
    </div>
  );
}

function SegmentForm({
  workspaceId,
  projectId,
  environment,
  segment,
  onDone,
}: Props & {
  segment: FlagSegmentDto | null;
  /** Called after a save (with a notice when it waits for approval) or on cancel. */
  onDone: (notice?: string) => void;
}) {
  const utils = trpc.useUtils();
  const [key, setKey] = useState(segment?.key ?? '');
  const [name, setName] = useState(segment?.name ?? '');
  const [included, setIncluded] = useState(segment?.includedKeys.join('\n') ?? '');
  const [excluded, setExcluded] = useState(segment?.excludedKeys.join('\n') ?? '');
  const [groups, setGroups] = useState<GroupDraft[]>(
    () =>
      segment?.rules.map(group => ({
        id: draftId(),
        clauses: group.map(clause => ({
          id: draftId(),
          kind: 'attribute' as const,
          ...clause,
          values: clause.values.join(', '),
        })),
      })) ?? [],
  );
  const save = trpc.flags.applyChangeset.useMutation({
    onSuccess: async result => {
      await Promise.all([
        utils.flags.segments.invalidate(),
        utils.flags.environments.invalidate(),
        utils.flags.timeline.invalidate(),
      ]);
      onDone(result.outcome === 'pending_approval' ? 'The segment change was sent for approval.' : undefined);
    },
  });
  const setGroup = (id: string, clauses: ClauseDraft[] | null) => {
    setGroups(previous =>
      clauses === null
        ? previous.filter(group => group.id !== id)
        : previous.map(group => (group.id === id ? { ...group, clauses } : group)),
    );
  };

  return (
    <form
      aria-label={segment === null ? 'Create a segment' : `Edit segment ${segment.key}`}
      className="flex flex-col gap-3 rounded-xl bg-muted/40 p-4"
      onSubmit={event => {
        event.preventDefault();
        save.mutate({
          workspaceId,
          projectId,
          environmentId: environment.id,
          baseVersion: environment.currentVersion,
          ops: [
            {
              op: 'set_segment',
              segmentKey: key,
              segment: {
                name,
                includedKeys: keysOf(included),
                excludedKeys: keysOf(excluded),
                rules: groups.map(group =>
                  group.clauses.flatMap(clause => (clause.kind === 'attribute' ? [toAttributeClause(clause)] : [])),
                ),
              },
            },
          ],
        });
      }}>
      <div className="flex flex-wrap gap-2">
        <label className={labelClass}>
          Key
          <input
            required
            value={key}
            disabled={segment !== null}
            pattern={SEGMENT_KEY_PATTERN.source}
            placeholder="beta-testers"
            className={`${inputClass} font-mono`}
            onChange={event => {
              setKey(event.target.value);
            }}
          />
        </label>
        <label className={labelClass}>
          Name
          <input
            required
            value={name}
            placeholder="Beta testers"
            className={inputClass}
            onChange={event => {
              setName(event.target.value);
            }}
          />
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={labelClass}>
          Always in (targeting keys, one per line)
          <textarea
            rows={3}
            value={included}
            className={`${inputClass} h-auto py-1.5 font-mono text-xs`}
            onChange={event => {
              setIncluded(event.target.value);
            }}
          />
        </label>
        <label className={labelClass}>
          Never in (targeting keys, one per line)
          <textarea
            rows={3}
            value={excluded}
            className={`${inputClass} h-auto py-1.5 font-mono text-xs`}
            onChange={event => {
              setExcluded(event.target.value);
            }}
          />
        </label>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Also in when any group matches (all conditions in a group)
        </span>
        {groups.map((group, index) => (
          <GroupEditor
            key={group.id}
            group={group}
            position={index + 1}
            onChange={clauses => {
              setGroup(group.id, clauses);
            }}
          />
        ))}
        <Button
          variant="outline"
          size="sm"
          className="w-fit text-xs"
          onClick={() => {
            setGroups(previous => [...previous, { id: draftId(), clauses: [emptyAttributeClause()] }]);
          }}>
          + Group
        </Button>
      </div>
      <div className="flex gap-2">
        <Button type="submit" pending={save.isPending} disabled={key === '' || name === ''} className="text-sm">
          Save segment
        </Button>
        <Button
          variant="ghost"
          className="text-sm"
          onClick={() => {
            onDone();
          }}>
          Cancel
        </Button>
      </div>
      {save.error ? <p className="text-sm text-destructive">{errorMessage(save.error)}</p> : null}
    </form>
  );
}

function SegmentRow({ workspaceId, projectId, environment, segment }: Props & { segment: FlagSegmentDto }) {
  const utils = trpc.useUtils();
  const [isEditing, setIsEditing] = useState(false);
  const removal = trpc.flags.applyChangeset.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.flags.segments.invalidate(),
        utils.flags.environments.invalidate(),
        utils.flags.timeline.invalidate(),
      ]);
    },
  });
  if (isEditing) {
    return (
      <li>
        <SegmentForm
          workspaceId={workspaceId}
          projectId={projectId}
          environment={environment}
          segment={segment}
          onDone={() => {
            setIsEditing(false);
          }}
        />
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{segment.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{segment.key}</span>
        <StatusBadge tone={Tones.neutral}>
          {segment.includedKeys.length} in · {segment.excludedKeys.length} out · {segment.rules.length} group
          {segment.rules.length === 1 ? '' : 's'}
        </StatusBadge>
        <span className="ml-auto flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit segment ${segment.key}`}
            onClick={() => {
              setIsEditing(true);
            }}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Delete segment ${segment.key}`}
            pending={removal.isPending}
            onClick={() => {
              removal.mutate({
                workspaceId,
                projectId,
                environmentId: environment.id,
                baseVersion: environment.currentVersion,
                ops: [{ op: 'delete_segment', segmentKey: segment.key }],
              });
            }}>
            Delete
          </Button>
        </span>
      </div>
      {removal.error ? <p className="text-xs text-destructive">{errorMessage(removal.error)}</p> : null}
    </li>
  );
}

/** The segments of one environment, with create, edit and delete. */
export default function Segments({ workspaceId, projectId, environment }: Props) {
  const segmentsQuery = trpc.flags.segments.useQuery({ workspaceId, projectId, environmentId: environment.id });
  const [isCreating, setIsCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const segments = segmentsQuery.data?.segments ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">Segments in {environment.name}</h2>
          <p className="text-xs text-muted-foreground">
            Named groups of users that flag rules can target. Each environment has its own segments, so changing one is
            reviewed like any other change to that environment.
          </p>
        </div>
        {isCreating ? null : (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 text-xs"
            onClick={() => {
              setIsCreating(true);
            }}>
            New segment
          </Button>
        )}
      </div>
      {isCreating ? (
        <SegmentForm
          workspaceId={workspaceId}
          projectId={projectId}
          environment={environment}
          segment={null}
          onDone={message => {
            setIsCreating(false);
            setNotice(message ?? null);
          }}
        />
      ) : null}
      {notice === null ? null : <p className="text-xs text-muted-foreground">{notice}</p>}
      {segments.length === 0 && !isCreating ? <p className="text-sm text-muted-foreground">No segments yet.</p> : null}
      <ul className="flex flex-col gap-2">
        {segments.map(segment => (
          <SegmentRow
            key={segment.key}
            workspaceId={workspaceId}
            projectId={projectId}
            environment={environment}
            segment={segment}
          />
        ))}
      </ul>
    </section>
  );
}
