// What a status page reports on (#148): component groups and components. Each component
// has the status an operator reports by hand and the status the page shows, which open
// incidents and maintenance in progress can make worse. Groups and components are
// renamed, moved and deleted here.
import { componentStatusSchema, ComponentStatuses } from '@mocco/common/status';
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { useState } from 'react';

import { errorMessage, inputClass, labelClass, Spinner } from '@frontend/components/notifications/notification-ui';
import { ComponentStatusBadge, componentStatusLabels } from '@frontend/components/status/status-ui';
import { Button } from '@frontend/components/ui/button';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { trpc } from '@frontend/lib/trpc';

import type { StatusOutputs } from '@frontend/components/status/status-ui';

interface Props {
  workspaceId: string;
  projectId: string;
  pageId: string;
}

type PageData = StatusOutputs['page'];
type Component = PageData['components'][number];
type Group = PageData['groups'][number];

// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const isBlank = (value: string) => value.trim() === '';

/** `items` with the one at `from` moved to `to`. */
function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** The positions that put `ordered` in its order, for the items whose position changes. */
function renumbered<T extends { id: string; position: number }>(ordered: readonly T[]) {
  return ordered.flatMap((item, index) => (item.position === index ? [] : [{ item, position: index }]));
}

/**
 * The page's components after moving `component` one step up or down among the components
 * of its own group (components are ordered across the page, and shown grouped).
 */
function componentsAfterMove(components: readonly Component[], component: Component, step: -1 | 1): Component[] {
  const from = components.findIndex(entry => entry.id === component.id);
  const siblings = components
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.groupId === component.groupId);
  const at = siblings.findIndex(({ entry }) => entry.id === component.id);
  const neighbor = siblings[at + step];
  return neighbor === undefined ? [...components] : moved(components, from, neighbor.index);
}

function MoveButtons({
  label,
  isFirst,
  isLast,
  isPending,
  onMove,
}: {
  label: string;
  isFirst: boolean;
  isLast: boolean;
  isPending: boolean;
  onMove: (step: -1 | 1) => void;
}) {
  return (
    <span className="flex">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${label} up`}
        disabled={isFirst || isPending}
        onClick={() => {
          onMove(-1);
        }}>
        <ArrowUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${label} down`}
        disabled={isLast || isPending}
        onClick={() => {
          onMove(1);
        }}>
        <ArrowDownIcon />
      </Button>
    </span>
  );
}

/** A delete button that asks once more before deleting. */
function ConfirmDelete({ label, isPending, onDelete }: { label: string; isPending: boolean; onDelete: () => void }) {
  const [isConfirming, setIsConfirming] = useState(false);
  return isConfirming ? (
    <span className="flex gap-1">
      <Button variant="destructive" size="sm" pending={isPending} onClick={onDelete}>
        Delete {label}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setIsConfirming(false);
        }}>
        Keep
      </Button>
    </span>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Delete ${label}`}
      onClick={() => {
        setIsConfirming(true);
      }}>
      Delete
    </Button>
  );
}

function GroupSelect({
  groups,
  value,
  onChange,
}: {
  groups: readonly Group[];
  value: string;
  onChange: (groupId: string) => void;
}) {
  return (
    <label className={labelClass}>
      Group
      <select
        className={inputClass}
        value={value}
        onChange={event => {
          onChange(event.target.value);
        }}>
        <option value="">No group</option>
        {groups.map(group => (
          <option key={group.id} value={group.id}>
            {group.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ComponentRow({
  workspaceId,
  projectId,
  component,
  groups,
  isFirst,
  isLast,
  isMoving,
  onMove,
}: Omit<Props, 'pageId'> & {
  component: Component;
  groups: readonly Group[];
  isFirst: boolean;
  isLast: boolean;
  isMoving: boolean;
  onMove: (step: -1 | 1) => void;
}) {
  const utils = trpc.useUtils();
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(component.name);
  const [description, setDescription] = useState(component.description ?? '');
  const [groupId, setGroupId] = useState(component.groupId ?? '');
  const refresh = async () => {
    await utils.status.page.invalidate();
  };
  const reportStatus = trpc.status.setComponentStatus.useMutation({ onSuccess: refresh });
  const update = trpc.status.updateComponent.useMutation({
    onSuccess: async () => {
      setIsEditing(false);
      await refresh();
    },
  });
  const remove = trpc.status.deleteComponent.useMutation({ onSuccess: refresh });
  const scope = { workspaceId, projectId, componentId: component.id };
  const isOverridden = component.displayedStatus !== component.status;
  const error = errorMessage(reportStatus.error ?? update.error ?? remove.error);

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{component.name}</span>
            <ComponentStatusBadge status={component.displayedStatus} />
          </span>
          {component.description === null ? null : (
            <span className="text-xs text-muted-foreground">{component.description}</span>
          )}
          {isOverridden ? (
            <span className="text-xs text-muted-foreground">
              Reported as {componentStatusLabels[component.status].toLowerCase()}; an open incident or maintenance in
              progress makes it show {componentStatusLabels[component.displayedStatus].toLowerCase()}.
            </span>
          ) : null}
        </span>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Reported status
          <select
            aria-label={`Reported status of ${component.name}`}
            className={inputClass}
            value={component.status}
            disabled={reportStatus.isPending}
            onChange={event => {
              const parsed = componentStatusSchema.safeParse(event.target.value);
              if (parsed.success) {
                reportStatus.mutate({ ...scope, status: parsed.data });
              }
            }}>
            {Object.values(ComponentStatuses).map(status => (
              <option key={status} value={status}>
                {componentStatusLabels[status]}
              </option>
            ))}
          </select>
        </label>
        <span className="flex items-center gap-1">
          <MoveButtons label={component.name} isFirst={isFirst} isLast={isLast} isPending={isMoving} onMove={onMove} />
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${component.name}`}
            aria-expanded={isEditing}
            onClick={() => {
              setIsEditing(previous => !previous);
            }}>
            Edit
          </Button>
          <ConfirmDelete
            label={component.name}
            isPending={remove.isPending}
            onDelete={() => {
              remove.mutate(scope);
            }}
          />
        </span>
      </div>
      {isEditing ? (
        <form
          aria-label={`Edit ${component.name}`}
          className="flex flex-wrap items-end gap-2"
          onSubmit={event => {
            event.preventDefault();
            update.mutate({
              ...scope,
              name,
              description: isBlank(description) ? null : description,
              groupId: groupId === '' ? null : groupId,
            });
          }}>
          <label className={labelClass}>
            Name
            <input
              className={inputClass}
              value={name}
              maxLength={120}
              onChange={event => {
                setName(event.target.value);
              }}
            />
          </label>
          <label className={`${labelClass} min-w-48 flex-1`}>
            Description
            <input
              className={inputClass}
              value={description}
              maxLength={500}
              onChange={event => {
                setDescription(event.target.value);
              }}
            />
          </label>
          <GroupSelect groups={groups} value={groupId} onChange={setGroupId} />
          <Button
            type="submit"
            variant="outline"
            className="text-sm"
            pending={update.isPending}
            disabled={isBlank(name)}>
            Save
          </Button>
        </form>
      ) : null}
      {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
    </li>
  );
}

function ComponentList({
  workspaceId,
  projectId,
  components,
  all,
  groups,
  isMoving,
  onMove,
}: Omit<Props, 'pageId'> & {
  components: readonly Component[];
  all: readonly Component[];
  groups: readonly Group[];
  isMoving: boolean;
  onMove: (ordered: Component[]) => void;
}) {
  if (components.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">No components yet.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border">
      {components.map((component, index) => (
        <ComponentRow
          // Remount after a save so the edit form starts from the saved values.
          key={`${component.id}:${component.name}:${component.description ?? ''}:${component.groupId ?? ''}`}
          workspaceId={workspaceId}
          projectId={projectId}
          component={component}
          groups={groups}
          isFirst={index === 0}
          isLast={index === components.length - 1}
          isMoving={isMoving}
          onMove={step => {
            onMove(componentsAfterMove(all, component, step));
          }}
        />
      ))}
    </ul>
  );
}

function GroupHeader({
  workspaceId,
  projectId,
  group,
  isFirst,
  isLast,
  isMoving,
  onMove,
}: Omit<Props, 'pageId'> & {
  group: Group;
  isFirst: boolean;
  isLast: boolean;
  isMoving: boolean;
  onMove: (step: -1 | 1) => void;
}) {
  const utils = trpc.useUtils();
  const [isRenaming, setIsRenaming] = useState(false);
  const [name, setName] = useState(group.name);
  const rename = trpc.status.updateGroup.useMutation({
    onSuccess: async () => {
      setIsRenaming(false);
      await utils.status.page.invalidate();
    },
  });
  const remove = trpc.status.deleteGroup.useMutation({
    onSuccess: async () => {
      await utils.status.page.invalidate();
    },
  });
  const error = errorMessage(rename.error ?? remove.error);

  return (
    <div className="flex flex-col gap-2 border-b border-border bg-muted/40 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {isRenaming ? (
          <form
            aria-label={`Rename ${group.name}`}
            className="flex flex-1 flex-wrap items-center gap-2"
            onSubmit={event => {
              event.preventDefault();
              rename.mutate({ workspaceId, projectId, groupId: group.id, name });
            }}>
            <input
              aria-label="Group name"
              className={inputClass}
              value={name}
              maxLength={120}
              onChange={event => {
                setName(event.target.value);
              }}
            />
            <Button type="submit" variant="outline" size="sm" pending={rename.isPending} disabled={isBlank(name)}>
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsRenaming(false);
                setName(group.name);
              }}>
              Cancel
            </Button>
          </form>
        ) : (
          <h3 className="flex-1 text-sm font-medium">{group.name}</h3>
        )}
        <MoveButtons label={group.name} isFirst={isFirst} isLast={isLast} isPending={isMoving} onMove={onMove} />
        {isRenaming ? null : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Rename ${group.name}`}
            onClick={() => {
              setIsRenaming(true);
            }}>
            Rename
          </Button>
        )}
        <ConfirmDelete
          label={group.name}
          isPending={remove.isPending}
          onDelete={() => {
            remove.mutate({ workspaceId, projectId, groupId: group.id });
          }}
        />
      </div>
      {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function AddComponent({ workspaceId, projectId, pageId, groups }: Props & { groups: readonly Group[] }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [groupId, setGroupId] = useState('');
  const create = trpc.status.createComponent.useMutation({
    onSuccess: async () => {
      setName('');
      setDescription('');
      await utils.status.page.invalidate();
    },
  });
  return (
    <form
      aria-label="New component"
      className="flex flex-wrap items-end gap-2"
      onSubmit={event => {
        event.preventDefault();
        create.mutate({
          workspaceId,
          projectId,
          pageId,
          name,
          description: isBlank(description) ? null : description,
          groupId: groupId === '' ? null : groupId,
        });
      }}>
      <label className={labelClass}>
        New component
        <input
          className={inputClass}
          placeholder="REST API"
          value={name}
          maxLength={120}
          onChange={event => {
            setName(event.target.value);
          }}
        />
      </label>
      <label className={`${labelClass} min-w-48 flex-1`}>
        Description (optional)
        <input
          className={inputClass}
          placeholder="api.example.com"
          value={description}
          maxLength={500}
          onChange={event => {
            setDescription(event.target.value);
          }}
        />
      </label>
      {groups.length === 0 ? null : <GroupSelect groups={groups} value={groupId} onChange={setGroupId} />}
      <Button type="submit" variant="outline" className="text-sm" pending={create.isPending} disabled={isBlank(name)}>
        Add component
      </Button>
      {create.error ? <p className="w-full text-sm text-destructive">{errorMessage(create.error)}</p> : null}
    </form>
  );
}

function AddGroup({ workspaceId, projectId, pageId }: Props) {
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const create = trpc.status.createGroup.useMutation({
    onSuccess: async () => {
      setName('');
      await utils.status.page.invalidate();
    },
  });
  return (
    <form
      aria-label="New group"
      className="flex flex-wrap items-end gap-2"
      onSubmit={event => {
        event.preventDefault();
        create.mutate({ workspaceId, projectId, pageId, name });
      }}>
      <label className={labelClass}>
        New group
        <input
          className={inputClass}
          placeholder="API"
          value={name}
          maxLength={120}
          onChange={event => {
            setName(event.target.value);
          }}
        />
      </label>
      <Button type="submit" variant="outline" className="text-sm" pending={create.isPending} disabled={isBlank(name)}>
        Add group
      </Button>
      {create.error ? <p className="w-full text-sm text-destructive">{errorMessage(create.error)}</p> : null}
    </form>
  );
}

export default function PageComponents({ workspaceId, projectId, pageId }: Props) {
  const utils = trpc.useUtils();
  const pageQuery = trpc.status.page.useQuery({ workspaceId, projectId, pageId });
  const moveComponent = trpc.status.updateComponent.useMutation();
  const moveGroup = trpc.status.updateGroup.useMutation();
  const [moveError, setMoveError] = useState<string | null>(null);
  if (pageQuery.isPending) {
    return <Spinner />;
  }
  if (pageQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(pageQuery.error)}</p>;
  }
  const { groups, components } = pageQuery.data;
  const isMoving = moveComponent.isPending || moveGroup.isPending;

  /** Save the new order (only the positions that change), then reload the page. */
  const saveOrder = async (writes: Promise<unknown>[]) => {
    setMoveError(null);
    try {
      await Promise.all(writes);
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : 'The new order was not saved.');
    }
    await utils.status.page.invalidate();
  };
  const reorderComponents = (ordered: Component[]) => {
    fireAndForget(
      saveOrder(
        renumbered(ordered).map(
          async ({ item, position }) =>
            await moveComponent.mutateAsync({
              workspaceId,
              projectId,
              componentId: item.id,
              name: item.name,
              position,
            }),
        ),
      ),
    );
  };
  const moveGroupBy = (index: number, step: -1 | 1) => {
    fireAndForget(
      saveOrder(
        renumbered(moved(groups, index, index + step)).map(
          async ({ item, position }) =>
            await moveGroup.mutateAsync({ workspaceId, projectId, groupId: item.id, name: item.name, position }),
        ),
      ),
    );
  };
  const listProps = { workspaceId, projectId, all: components, groups, isMoving, onMove: reorderComponents };
  const ungrouped = components.filter(component => component.groupId === null);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Components</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          The parts of your service the page reports on. Set the status you report by hand; an open incident or
          maintenance in progress can make a component show worse than that.
        </p>
      </div>
      {moveError === null ? null : <p className="text-sm text-destructive">{moveError}</p>}
      {groups.length === 0 || ungrouped.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-border">
          <ComponentList components={ungrouped} {...listProps} />
        </div>
      ) : null}
      {groups.map((group, index) => (
        <div key={group.id} className="overflow-hidden rounded-xl border border-border">
          <GroupHeader
            key={`${group.id}:${group.name}`}
            workspaceId={workspaceId}
            projectId={projectId}
            group={group}
            isFirst={index === 0}
            isLast={index === groups.length - 1}
            isMoving={isMoving}
            onMove={step => {
              moveGroupBy(index, step);
            }}
          />
          <ComponentList components={components.filter(component => component.groupId === group.id)} {...listProps} />
        </div>
      ))}
      <AddComponent workspaceId={workspaceId} projectId={projectId} pageId={pageId} groups={groups} />
      <AddGroup workspaceId={workspaceId} projectId={projectId} pageId={pageId} />
    </section>
  );
}
