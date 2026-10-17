// The page changes an agent can make, as the console's page screens make them: the status a
// component reports, set by hand.
//
// A thin adapter (ADR 0025) over `StatusPageService`, the service the console's `status` router
// writes through, with the locks and refusals in `status-write.ts`. The status shows on the public
// page at once, so the confirmation says so; it is bound to the status set by hand when the person
// was asked, so a change someone makes meanwhile is asked about afresh.
import { componentStatusSchema } from '@mocco/common/status';
import { z } from 'zod';

import { StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { confirmThenApply } from '@backend/transport/mcp/tools/deciding';
import { asJson, workspaceArg } from '@backend/transport/mcp/tools/runs';
import { projectArg } from '@backend/transport/mcp/tools/status';
import {
  openStatusChange,
  pageLabel,
  statusRefusal,
  statusWords,
  statusWriteChallenge,
} from '@backend/transport/mcp/tools/status-write';

import type { ProjectInScope } from '@backend/domain/mcp/ProjectScope';
import type { StatusChanges, StatusWriteToolDeps } from '@backend/transport/mcp/tools/status-write';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export const StatusPageTools = {
  setComponentStatus: 'mocco_status_component_status_set',
} as const;

const componentArg = z.uuid().describe('The component, by id as `mocco_status_pages_get` gives it.');

const componentStatusInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  componentId: componentArg,
  status: componentStatusSchema.describe(
    'The status to report by hand: `operational`, `maintenance`, `degraded`, `partial_outage` or `major_outage`.',
  ),
});

export type SetComponentStatusArgs = z.infer<typeof componentStatusInput>;

/** The component among the project's pages, with its page; another project's reads like one that does not exist. */
export async function componentIn(changes: StatusChanges, scope: ProjectInScope, componentId: string) {
  const pages = await changes.pages.listPages(scope);
  const read = await Promise.all(pages.map(async listed => await changes.pages.getPage(scope, listed.id)));
  const found = read.find(({ components }) => components.some(each => each.id === componentId));
  const component = found?.components.find(each => each.id === componentId);
  if (found === undefined || component === undefined) {
    throw new StatusEntityNotFoundError('component', componentId);
  }
  return { page: found.page, component, groups: found.groups };
}

export async function setComponentStatus(
  deps: StatusWriteToolDeps,
  args: SetComponentStatusArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(
      deps,
      ctx,
      args,
      statusWords('set component statuses', 'Setting a component status'),
    );
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const { page, component } = await componentIn(changes, scope, args.componentId);
    if (component.status === args.status) {
      return asJson({ changed: false, componentId: component.id, reason: `It is set to ${args.status} already.` });
    }
    const change = {
      tool: StatusPageTools.setComponentStatus,
      ...scope,
      componentId: component.id,
      from: component.status,
      to: args.status,
    };
    const question = [
      `Set component "${component.name}" on the status page ${pageLabel(page)} to ${args.status}, as you?`,
      'PUBLIC: the page shows it at once. Subscribers are not sent anything for it.',
      `Set by hand now: ${component.status} → ${args.status}`,
      `The page shows now: ${component.displayedStatus}. Open incidents and maintenance in progress still count toward what it shows.`,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Set this status',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const updated = await changes.pages.setComponentStatus(scope, userId, component.id, args.status);
        return asJson({ changed: true, component: { id: updated.id, name: updated.name, status: updated.status } });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export function registerStatusPageTools(server: McpServer, deps: StatusWriteToolDeps): void {
  server.registerTool(
    StatusPageTools.setComponentStatus,
    {
      title: "Set a component's status",
      description:
        'Set the status a status page component reports by hand (operational, maintenance, degraded, partial or major outage), as the signed-in person; the page shows it at once, and open incidents and maintenance still count toward what it shows. The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes.',
      inputSchema: componentStatusInput,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Setting a component status'),
    },
    async (args, ctx) => await setComponentStatus(deps, args, ctx),
  );
}
