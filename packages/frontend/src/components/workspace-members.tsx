import { trpc } from '@frontend/lib/trpc';

interface Props {
  workspaceId: string;
}

// Read-only list of a workspace's members (name, email, role). Inviting and
// removing land later — they need an invitation (email) flow.
export default function WorkspaceMembers({ workspaceId }: Props) {
  const membersQuery = trpc.workspace.members.useQuery({ workspaceId });
  const members = membersQuery.data?.members ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Members</h1>
        <p className="text-sm text-muted-foreground">People with access to this workspace. Inviting lands here soon.</p>
      </div>

      <ul className="flex flex-col gap-2">
        {members.map(member => (
          <li key={member.id} className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
            <div className="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-semibold">
              {member.user.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{member.user.name}</div>
              <div className="truncate text-xs text-muted-foreground">{member.user.email}</div>
            </div>
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground capitalize">
              {member.role}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
