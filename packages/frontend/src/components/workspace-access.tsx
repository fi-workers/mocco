import { useState } from 'react';

import { Button } from '@frontend/components/ui/button';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { trpc } from '@frontend/lib/trpc';

import type { RoleDto } from '@mocco/common/governance';
import type { WorkspaceMemberDetailDto } from '@mocco/common/workspace';

const inputClass = 'h-9 w-56 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring';

interface Props {
  workspaceId: string;
}

/** One role: its assigned members (add from the workspace, remove) and a delete. */
function RoleCard({
  workspaceId,
  role,
  workspaceMembers,
}: {
  workspaceId: string;
  role: RoleDto;
  workspaceMembers: WorkspaceMemberDetailDto[];
}) {
  const utils = trpc.useUtils();
  const membersQuery = trpc.role.listMembers.useQuery({ workspaceId, roleId: role.id });
  const members = membersQuery.data?.members ?? [];

  const { mutateAsync: addMember, isPending: isAdding } = trpc.role.addMember.useMutation();
  const { mutateAsync: removeMember } = trpc.role.removeMember.useMutation();
  const { mutateAsync: deleteRole, isPending: isDeleting } = trpc.role.delete.useMutation();

  const [selectedUserId, setSelectedUserId] = useState('');

  // Workspace members not already assigned to this role — the add candidates.
  const assignedUserIds = new Set(members.map(member => member.userId));
  const candidates = workspaceMembers.filter(member => !assignedUserIds.has(member.userId));

  const add = async (): Promise<void> => {
    if (selectedUserId === '') {
      return;
    }
    await addMember({ workspaceId, roleId: role.id, userId: selectedUserId });
    setSelectedUserId('');
    await utils.role.listMembers.invalidate({ workspaceId, roleId: role.id });
  };

  const remove = async (userId: string): Promise<void> => {
    await removeMember({ workspaceId, roleId: role.id, userId });
    await utils.role.listMembers.invalidate({ workspaceId, roleId: role.id });
  };

  const removeRole = async (): Promise<void> => {
    await deleteRole({ workspaceId, roleId: role.id });
    await utils.role.list.invalidate({ workspaceId });
  };

  return (
    <li className="flex flex-col gap-4 rounded-xl border border-border px-4 py-4">
      <div className="flex items-center gap-3">
        <span className="flex-1 truncate text-sm font-semibold">{role.name}</span>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          pending={isDeleting}
          onClick={() => {
            fireAndForget(removeRole());
          }}>
          Delete role
        </Button>
      </div>

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">No members in this role yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {members.map(member => (
            <li key={member.id} className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{member.user.name ?? member.user.email}</div>
                <div className="truncate text-xs text-muted-foreground">{member.user.email}</div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  fireAndForget(remove(member.userId));
                }}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <select
          aria-label={`Add a member to ${role.name}`}
          className={inputClass}
          value={selectedUserId}
          disabled={candidates.length === 0}
          onChange={event => {
            setSelectedUserId(event.target.value);
          }}>
          <option value="">{candidates.length === 0 ? 'Everyone is assigned' : 'Select a member…'}</option>
          {candidates.map(member => (
            <option key={member.userId} value={member.userId}>
              {member.user.name ?? member.user.email} ({member.user.email})
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          pending={isAdding}
          disabled={selectedUserId === ''}
          onClick={() => {
            fireAndForget(add());
          }}>
          Add
        </Button>
      </div>
    </li>
  );
}

// The Access surface: a workspace's roles (create/delete) and each role's member
// assignments (add from the workspace's members, remove). Roles are the
// authorization surface gates resume against (added in later PRs of this slice).
export default function WorkspaceAccess({ workspaceId }: Props) {
  const utils = trpc.useUtils();
  const rolesQuery = trpc.role.list.useQuery({ workspaceId });
  const roles = rolesQuery.data?.roles ?? [];
  const membersQuery = trpc.workspace.members.useQuery({ workspaceId });
  const workspaceMembers = membersQuery.data?.members ?? [];

  const { mutateAsync: createRole, isPending: isCreating } = trpc.role.create.useMutation();
  const [roleName, setRoleName] = useState('');

  const create = async (): Promise<void> => {
    // eslint-disable-next-line sonarjs/null-dereference -- roleName is a useState<string>, never null
    const trimmed = roleName.trim();
    if (trimmed === '') {
      return;
    }
    await createRole({ workspaceId, name: trimmed });
    setRoleName('');
    await utils.role.list.invalidate({ workspaceId });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Access</h1>
        <p className="text-sm text-muted-foreground">
          Define roles and assign members. Gates require an authorized role to resume a run.
        </p>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={event => {
          event.preventDefault();
          fireAndForget(create());
        }}>
        <input
          aria-label="New role name"
          className={inputClass}
          value={roleName}
          placeholder="e.g. deployer"
          onChange={event => {
            setRoleName(event.target.value);
          }}
        />
        <Button type="submit" pending={isCreating} disabled={roleName.trim() === ''}>
          Create role
        </Button>
      </form>

      {roles.length === 0 ? (
        <p className="text-sm text-muted-foreground">No roles yet. Create one to start assigning members.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {roles.map(role => (
            <RoleCard key={role.id} workspaceId={workspaceId} role={role} workspaceMembers={workspaceMembers} />
          ))}
        </ul>
      )}
    </div>
  );
}
