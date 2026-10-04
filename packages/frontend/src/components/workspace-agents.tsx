import { Ago, errorMessage } from '@frontend/components/notifications/notification-ui';
import { trpc } from '@frontend/lib/trpc';
import { useWorkspaceAdmin } from '@frontend/lib/use-workspace-admin';

interface Props {
  workspaceId: string;
}

// Workspace settings → Agents: whether an agent connected over MCP may cast votes and
// resume gates. Off by default; owners and admins switch it, everyone else sees it.
export default function WorkspaceAgents({ workspaceId }: Props) {
  const utils = trpc.useUtils();
  const { isAdmin } = useWorkspaceAdmin(workspaceId);
  const settingsQuery = trpc.mcp.settings.useQuery({ workspaceId });
  const membersQuery = trpc.workspace.members.useQuery({ workspaceId });
  const change = trpc.mcp.setAgentsMayDecide.useMutation({
    onSuccess: async () => {
      await utils.mcp.settings.invalidate({ workspaceId });
    },
  });

  const settings = settingsQuery.data?.settings;
  const changedBy = membersQuery.data?.members.find(member => member.userId === settings?.changedByUserId)?.user.name;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">Agents</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Agents connected through Mocco&apos;s MCP server can always read runs and approvals. This decides whether they
          can also approve, reject and resume.
        </p>
      </div>
      {settings ? (
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.agentsMayDecide}
              disabled={!isAdmin || change.isPending}
              onChange={event => {
                change.mutate({ workspaceId, agentsMayDecide: event.target.checked });
              }}
            />
            Allow agents to decide
          </label>
          <p className="max-w-prose text-xs text-muted-foreground">
            An agent still acts as the person who connected it, so it can only cast a vote that person could cast, and
            the person confirms each decision before it is made.
            {isAdmin ? null : ' Owners and admins change this.'}
          </p>
          {settings.changedAt ? (
            <p className="text-xs text-muted-foreground">
              {settings.agentsMayDecide ? 'Turned on' : 'Turned off'} <Ago date={settings.changedAt} />
              {changedBy === undefined ? null : ` by ${changedBy}`}
            </p>
          ) : null}
          {change.error ? <p className="text-xs text-destructive">{errorMessage(change.error)}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
