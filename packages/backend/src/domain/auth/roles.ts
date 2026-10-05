// Which workspace roles count as an owner or admin: one rule, read by the console's
// session check (`WorkspaceService.assertAdmin`) and by MCP's token check
// (`WorkspaceScope.requireAdmin`), so the two cannot drift apart.
import { WorkspaceMemberRoles } from '@mocco/common/workspace';

/** Workspace roles that may change workspace-level settings (the org plugin's owner/admin). */
const ADMIN_ROLES: ReadonlySet<string> = new Set([WorkspaceMemberRoles.owner, WorkspaceMemberRoles.admin]);

/** A stored role, split: the org plugin may keep a comma-joined set (`member,admin`). */
export function splitRoles(role: string): string[] {
  // sonarjs/null-dereference is a false positive: `role` and each part are non-nullable strings.
  /* eslint-disable sonarjs/null-dereference */
  return role
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '');
  /* eslint-enable sonarjs/null-dereference */
}

/** Whether any of these roles is owner or admin. */
export const hasAdminRole = (roles: readonly string[]): boolean => roles.some(role => ADMIN_ROLES.has(role));
