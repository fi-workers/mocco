import { WorkspaceMemberRoles } from '@mocco/common/workspace';

import { useSession } from '@frontend/lib/auth-client';
import { trpc } from '@frontend/lib/trpc';

const ADMIN_ROLES: ReadonlySet<string> = new Set([WorkspaceMemberRoles.owner, WorkspaceMemberRoles.admin]);

/**
 * Whether the signed-in user is an owner or admin of the workspace, so a page can show
 * its read-only view to plain members. A UI hint only: the server checks every write.
 * A member's role may be a comma-joined set (`member,admin`), as the server reads it.
 */
export function useWorkspaceAdmin(workspaceId: string): { isAdmin: boolean } {
  const { data: session } = useSession();
  const membersQuery = trpc.workspace.members.useQuery({ workspaceId });
  const userId = session?.user.id;
  const me = membersQuery.data?.members.find(member => member.userId === userId);
  const roles = Array.from((me?.role ?? '').matchAll(/[^,\s]+/gu), match => match[0]);
  return { isAdmin: roles.some(role => ADMIN_ROLES.has(role)) };
}
