// The inbox's round robin (#204): who takes new conversations, and whether each of them
// is available. The bar over the conversations is the signed-in person's own toggle; the
// settings section adds and removes the workspace's members.
import { useState } from 'react';

import { Ago, errorMessage, inputClass } from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { useSession } from '@frontend/lib/auth-client';
import { trpc } from '@frontend/lib/trpc';

import type { ReactNode } from 'react';

interface Props {
  workspaceId: string;
  projectId: string;
}

/** The rotation's mutations, each refreshing the member list when it lands. */
function useRotation({ workspaceId, projectId }: Props) {
  const utils = trpc.useUtils();
  const refresh = { onSuccess: async () => await utils.messenger.inboxMembers.invalidate({ workspaceId, projectId }) };
  return {
    membersQuery: trpc.messenger.inboxMembers.useQuery({ workspaceId, projectId }),
    add: trpc.messenger.addInboxMember.useMutation(refresh),
    remove: trpc.messenger.removeInboxMember.useMutation(refresh),
    availability: trpc.messenger.setAvailability.useMutation(refresh),
  };
}

/** The signed-in person's place in the rotation: join it, or switch availability.
 * `children` sit at the end of the bar (the desktop notifications switch). */
export function AvailabilityBar({ workspaceId, projectId, children }: Props & { children?: ReactNode }) {
  const { data: session } = useSession();
  const { membersQuery, add, availability } = useRotation({ workspaceId, projectId });
  const userId = session?.user.id;
  if (userId === undefined || membersQuery.data === undefined) {
    return null;
  }
  const me = membersQuery.data.members.find(member => member.userId === userId);
  const error = errorMessage(add.error ?? availability.error);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-4 py-2.5 text-sm">
      {me === undefined ? (
        <>
          <span className="text-muted-foreground">
            You don&apos;t take new conversations here. Join the rotation to get your share.
          </span>
          <Button
            variant="outline"
            className="text-sm"
            pending={add.isPending}
            onClick={() => {
              add.mutate({ workspaceId, projectId, userId });
            }}>
            Join the rotation
          </Button>
        </>
      ) : (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={me.available}
            disabled={availability.isPending}
            onChange={event => {
              availability.mutate({ workspaceId, projectId, userId, available: event.target.checked });
            }}
          />
          {me.available ? 'Available: new conversations come to you in turn' : 'Away: new conversations skip you'}
        </label>
      )}
      {error === null ? null : <span className="text-xs text-destructive">{error}</span>}
      <span className="ml-auto">{children}</span>
    </div>
  );
}

/** The settings section: every member of the rotation, and adding the workspace's others. */
export function RotationSettings({ workspaceId, projectId }: Props) {
  const { membersQuery, add, remove, availability } = useRotation({ workspaceId, projectId });
  const workspaceMembersQuery = trpc.workspace.members.useQuery({ workspaceId });
  const [picked, setPicked] = useState('');
  const members = membersQuery.data?.members ?? [];
  const inRotation = new Set(members.map(member => member.userId));
  const candidates = (workspaceMembersQuery.data?.members ?? []).filter(member => !inRotation.has(member.userId));
  const error = errorMessage(add.error ?? remove.error ?? availability.error);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Round robin</h3>
      <p className="max-w-prose text-xs text-muted-foreground">
        Each new conversation goes to the available member who has waited longest for one. Away members are skipped.
        With no one available, conversations stay unassigned.
      </p>
      {members.length === 0 ? (
        <p className="text-xs text-muted-foreground">No one is in the rotation yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {members.map(member => (
            <li key={member.userId} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{member.name}</span>
                <span className="text-xs text-muted-foreground">
                  {member.lastAssignedAt === null ? (
                    'No conversations yet'
                  ) : (
                    <>
                      Last got one <Ago date={member.lastAssignedAt} />
                    </>
                  )}
                </span>
              </span>
              <label className="ml-auto flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={member.available}
                  disabled={availability.isPending}
                  onChange={event => {
                    availability.mutate({
                      workspaceId,
                      projectId,
                      userId: member.userId,
                      available: event.target.checked,
                    });
                  }}
                />
                Available
              </label>
              <Button
                variant="ghost"
                className="text-xs"
                pending={remove.isPending && remove.variables.userId === member.userId}
                onClick={() => {
                  remove.mutate({ workspaceId, projectId, userId: member.userId });
                }}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {candidates.length === 0 ? null : (
        <form
          aria-label="Add to the rotation"
          className="flex flex-wrap items-center gap-2"
          onSubmit={event => {
            event.preventDefault();
            if (picked !== '') {
              add.mutate({ workspaceId, projectId, userId: picked });
              setPicked('');
            }
          }}>
          <select
            aria-label="Workspace member"
            value={picked}
            onChange={event => {
              setPicked(event.target.value);
            }}
            className={inputClass}>
            <option value="">Choose a member…</option>
            {candidates.map(member => (
              <option key={member.userId} value={member.userId}>
                {member.user.name} ({member.user.email})
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline" className="text-sm" disabled={picked === ''} pending={add.isPending}>
            Add
          </Button>
        </form>
      )}
      {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
