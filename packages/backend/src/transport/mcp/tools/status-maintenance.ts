// The maintenance changes an agent can make on a status page, as the console's maintenance view
// makes them: schedule a window and cancel one.
//
// Thin adapters (ADR 0025) over `MaintenanceService`, the service the console's `status` router
// writes through, with the locks and refusals in `status-write.ts`. Both reach the public page at
// once and are sent to the page's subscribers, so the confirmation says so and shows the window
// exactly as it will be announced. A schedule is bound to the page's newest window, so answering
// the same confirmation twice schedules one window, not two; a cancel is bound to the window's
// status and times as shown, so a window that started (or was moved) meanwhile is asked about afresh.
import { MaintenanceStatuses, maintenanceInputSchema } from '@mocco/common/status';
import { z } from 'zod';

import { StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { confirmThenApply, refused } from '@backend/transport/mcp/tools/deciding';
import { workspaceArg, asJson } from '@backend/transport/mcp/tools/runs';
import { onePage, projectArg } from '@backend/transport/mcp/tools/status';
import {
  componentName,
  openStatusChange,
  pageLabel,
  statusRefusal,
  statusWords,
  statusWriteChallenge,
} from '@backend/transport/mcp/tools/status-write';

import type { ProjectInScope } from '@backend/domain/mcp/ProjectScope';
import type { StatusChanges, StatusWriteToolDeps } from '@backend/transport/mcp/tools/status-write';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export const StatusMaintenanceTools = {
  schedule: 'mocco_status_maintenance_schedule',
  cancel: 'mocco_status_maintenance_cancel',
} as const;

const fields = maintenanceInputSchema.shape;

const scheduleInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  pageId: z.uuid().optional().describe('The status page. Omit it when the project has exactly one.'),
  title: fields.title.describe('The title the page shows.'),
  body: fields.body.describe('What will happen, in Markdown, published as written. Empty for none.'),
  scheduledStart: z.iso
    .datetime({ offset: true })
    .describe('When it starts, ISO 8601 with a zone, e.g. `2026-10-20T02:00:00Z`.'),
  scheduledEnd: z.iso.datetime({ offset: true }).describe('When it ends, after it starts.'),
  componentIds: fields.componentIds.describe(
    'The components it covers, by id as `mocco_status_pages_get` gives them; they show maintenance while it runs.',
  ),
});

const cancelInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  maintenanceId: z.uuid().describe('The window, as `mocco_status_maintenances_search` returns it.'),
});

export type ScheduleMaintenanceArgs = z.infer<typeof scheduleInput>;
export type CancelMaintenanceArgs = z.infer<typeof cancelInput>;

const PUBLIC = "PUBLIC: it goes on the page at once, and the page's subscribers are sent it.";

const namesOf = (componentIds: readonly string[], names: ReadonlyMap<string, { name: string }>) =>
  componentIds.length === 0 ? 'none' : componentIds.map(id => componentName(names, id)).join(', ');

export async function scheduleMaintenance(
  deps: StatusWriteToolDeps,
  args: ScheduleMaintenanceArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(
      deps,
      ctx,
      args,
      statusWords('schedule maintenance', 'Scheduling maintenance'),
    );
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const scheduledStart = new Date(args.scheduledStart);
    const scheduledEnd = new Date(args.scheduledEnd);
    if (scheduledEnd <= scheduledStart) {
      return refused('A maintenance window ends after it starts.');
    }
    const pageId = await onePage({ statusPages: changes.pages }, scope, args.pageId);
    const { page, components } = await changes.pages.getPage(scope, pageId);
    const names = new Map(components.map(each => [each.id, each] as const));
    const missing = args.componentIds.find(id => !names.has(id));
    if (missing !== undefined) {
      throw new StatusEntityNotFoundError('component', missing);
    }
    const [newest] = await changes.maintenances.list(scope, pageId);
    const change = {
      tool: StatusMaintenanceTools.schedule,
      ...scope,
      pageId,
      page: { slug: page.slug, title: page.title },
      newestMaintenanceId: newest?.id ?? null,
      title: args.title,
      body: args.body,
      scheduledStart: scheduledStart.toISOString(),
      scheduledEnd: scheduledEnd.toISOString(),
      componentIds: args.componentIds,
    };
    const question = [
      `Schedule this maintenance on the status page ${pageLabel(page)}, as you?`,
      PUBLIC,
      'It starts and completes on its own at these times; the components it covers show maintenance meanwhile.',
      `Title: ${args.title}`,
      `From: ${change.scheduledStart}`,
      `To: ${change.scheduledEnd}`,
      `Covers: ${namesOf(args.componentIds, names)}`,
      ...(args.body === '' ? ['No description.'] : ['Description, published exactly as written:', '', args.body]),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Publish this maintenance',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const window = await changes.maintenances.schedule(scope, userId, {
          pageId,
          title: args.title,
          body: args.body,
          scheduledStart,
          scheduledEnd,
          componentIds: args.componentIds,
        });
        return asJson({
          created: true,
          maintenance: {
            id: window.id,
            pageId: window.pageId,
            title: window.title,
            status: window.status,
            scheduledStart: window.scheduledStart,
            scheduledEnd: window.scheduledEnd,
          },
        });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

/** The window among the project's pages; one of another project reads like one that does not exist. */
async function windowIn(changes: StatusChanges, scope: ProjectInScope, maintenanceId: string) {
  const pages = await changes.pages.listPages(scope);
  const listed = await Promise.all(
    pages.map(async page => ({ page, windows: await changes.maintenances.list(scope, page.id) })),
  );
  const [found] = listed.flatMap(({ page, windows }) =>
    windows.filter(each => each.id === maintenanceId).map(window => ({ window, page })),
  );
  if (found === undefined) {
    throw new StatusEntityNotFoundError('maintenance', maintenanceId);
  }
  return found;
}

export async function cancelMaintenance(
  deps: StatusWriteToolDeps,
  args: CancelMaintenanceArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords('cancel maintenance', 'Canceling maintenance'));
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const { window, page } = await windowIn(changes, scope, args.maintenanceId);
    if (window.status !== MaintenanceStatuses.scheduled && window.status !== MaintenanceStatuses.inProgress) {
      return refused(
        `Maintenance "${window.title}" is ${window.status}; only a scheduled or in-progress window can be canceled.`,
      );
    }
    const isRunning = window.status === MaintenanceStatuses.inProgress;
    // Bound to its status and times as shown: a window that started meanwhile is asked about afresh.
    const change = {
      tool: StatusMaintenanceTools.cancel,
      ...scope,
      maintenanceId: window.id,
      status: window.status,
      scheduledStart: window.scheduledStart.toISOString(),
      scheduledEnd: window.scheduledEnd.toISOString(),
    };
    const question = [
      `Cancel maintenance "${window.title}" on the status page ${pageLabel(page)}, as you?`,
      "PUBLIC: the page shows it canceled at once, and the page's subscribers are sent that.",
      `Now: ${window.status}, ${change.scheduledStart} to ${change.scheduledEnd}`,
      isRunning
        ? 'It is in progress: it ends now, and the components it covers stop showing maintenance.'
        : 'It will not start.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Cancel this maintenance',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const canceled = await changes.maintenances.cancel(scope, userId, window.id);
        return asJson({
          changed: true,
          maintenance: { id: canceled.id, status: canceled.status, actualEnd: canceled.actualEnd },
        });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

const CONFIRMED =
  'The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes.';

export function registerStatusMaintenanceTools(server: McpServer, deps: StatusWriteToolDeps): void {
  server.registerTool(
    StatusMaintenanceTools.schedule,
    {
      title: 'Schedule maintenance',
      description: `Schedule a maintenance window on a status page as the signed-in person: its title, description, start and end, and the components it covers. It is public at once and sent to the page's subscribers, and starts and completes on its own. ${CONFIRMED} The confirmation shows exactly what will be published.`,
      inputSchema: scheduleInput,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
      scopeChallenge: statusWriteChallenge('Scheduling maintenance'),
    },
    async (args, ctx) => await scheduleMaintenance(deps, args, ctx),
  );

  server.registerTool(
    StatusMaintenanceTools.cancel,
    {
      title: 'Cancel maintenance',
      description: `Cancel a scheduled or in-progress maintenance window as the signed-in person; one in progress ends now. The page shows it canceled and its subscribers are sent that. ${CONFIRMED}`,
      inputSchema: cancelInput,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Canceling maintenance'),
    },
    async (args, ctx) => await cancelMaintenance(deps, args, ctx),
  );
}
