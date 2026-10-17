// The gates that announce maintenance on a status page (#158), as the console's maintenance view
// lists and changes them: when a run resumes a gate with the name, a window with the title starts on
// the page for the components and completes when the run ends.
//
// Thin adapters (ADR 0025) over `MaintenanceService`, with the locks and refusals in
// `status-write.ts`. Setting one changes what a later deploy announces publicly, so the confirmation
// says so; it is bound to the gate's setting as shown (or to there being none), and a delete to the
// setting it removes.
import { GateMaintenanceLimits, StatusLimits } from '@mocco/common/status';
import { z } from 'zod';

import { StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { confirmThenApply } from '@backend/transport/mcp/tools/deciding';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';
import { onePage, projectArg, resolveStatusProject } from '@backend/transport/mcp/tools/status';
import {
  byText,
  componentName,
  openStatusChange,
  pageLabel,
  requireStatusChanges,
  statusRefusal,
  statusWords,
  statusWriteChallenge,
} from '@backend/transport/mcp/tools/status-write';

import type { ProjectInScope } from '@backend/domain/mcp/ProjectScope';
import type { GateMaintenanceRow } from '@backend/domain/status/repos/gate-maintenance.repo';
import type { StatusChanges, StatusWriteToolDeps } from '@backend/transport/mcp/tools/status-write';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export const StatusGateMaintenanceTools = {
  search: 'mocco_status_gate_maintenances_search',
  set: 'mocco_status_gate_maintenance_set',
  delete: 'mocco_status_gate_maintenance_delete',
} as const;

const pageArg = z.uuid().optional().describe('The status page. Omit it when the project has exactly one.');

const searchInput = z.object({ workspaceId: workspaceArg, projectId: projectArg, pageId: pageArg });

const gateToSetInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  pageId: pageArg,
  gateName: z
    .string()
    .trim()
    .min(1)
    .max(GateMaintenanceLimits.gateNameMax)
    .describe("The gate's name in the pipeline. One setting per gate name and page; setting it again replaces it."),
  title: z.string().trim().min(1).max(StatusLimits.nameMax).describe('The title of the window it starts.'),
  expectedMinutes: z
    .int()
    .min(1)
    .max(GateMaintenanceLimits.expectedMinutesMax)
    .describe('How long the window is expected to last; past it, the window is flagged as overrun.'),
  componentIds: z
    .array(z.uuid())
    .max(100)
    .default([])
    .describe('The components the window covers, by id as `mocco_status_pages_get` gives them.'),
});

const gateOnlyInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  gateMaintenanceId: z.uuid().describe('The setting, as `mocco_status_gate_maintenances_search` returns it.'),
});

export type SearchGateMaintenancesArgs = z.infer<typeof searchInput>;
export type SetGateMaintenanceArgs = z.infer<typeof gateToSetInput>;
export type GateOnlyArgs = z.infer<typeof gateOnlyInput>;

const settingOf = (row: GateMaintenanceRow) => ({
  id: row.id,
  pageId: row.pageId,
  gateName: row.gateName,
  title: row.title,
  expectedMinutes: row.expectedMinutes,
  componentIds: row.componentIds,
});

/** The bound shape of a setting: what it announces, never who set it. */
const boundOf = (row: GateMaintenanceRow | undefined) =>
  row === undefined
    ? null
    : {
        id: row.id,
        title: row.title,
        expectedMinutes: row.expectedMinutes,
        componentIds: row.componentIds.toSorted(byText),
      };

export async function searchGateMaintenances(
  deps: StatusWriteToolDeps,
  args: SearchGateMaintenancesArgs,
  userId: string,
) {
  const changes = requireStatusChanges(deps);
  const scope = await resolveStatusProject(deps, userId, args);
  const pageId = await onePage({ statusPages: changes.pages }, scope, args.pageId);
  const rows = await changes.maintenances.listGateMaintenances(scope, pageId);
  return { pageId, gateMaintenances: rows.map(row => settingOf(row)) };
}

async function pageNames(changes: StatusChanges, scope: ProjectInScope, pageId: string) {
  const { page, components } = await changes.pages.getPage(scope, pageId);
  return { page, names: new Map(components.map(each => [each.id, each] as const)) };
}

export async function setGateMaintenance(
  deps: StatusWriteToolDeps,
  args: SetGateMaintenanceArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(
      deps,
      ctx,
      args,
      statusWords('change status pages', 'Setting a gate to announce maintenance'),
    );
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const pageId = await onePage({ statusPages: changes.pages }, scope, args.pageId);
    const { page, names } = await pageNames(changes, scope, pageId);
    const missing = args.componentIds.find(id => !names.has(id));
    if (missing !== undefined) {
      throw new StatusEntityNotFoundError('component', missing);
    }
    const settings = await changes.maintenances.listGateMaintenances(scope, pageId);
    const existing = settings.find(row => row.gateName === args.gateName);
    const change = {
      tool: StatusGateMaintenanceTools.set,
      ...scope,
      pageId,
      gateName: args.gateName,
      from: boundOf(existing),
      title: args.title,
      expectedMinutes: args.expectedMinutes,
      componentIds: args.componentIds,
    };
    const covers = (ids: readonly string[]) =>
      ids.length === 0 ? 'none' : ids.map(id => componentName(names, id)).join(', ');
    const question = [
      `When a run resumes the gate "${args.gateName}", announce maintenance on the status page ${pageLabel(page)}, as you?`,
      'PUBLIC: from then on, resuming that gate starts a window on the page at once and its subscribers are sent it; the run ending completes it.',
      ...(existing === undefined
        ? []
        : [
            `Now: "${existing.title}", ${String(existing.expectedMinutes)} minutes, covering ${covers(existing.componentIds)}. This replaces it.`,
          ]),
      `Title: ${args.title}`,
      `Expected to last: ${String(args.expectedMinutes)} minutes`,
      `Covers: ${covers(args.componentIds)}`,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Set this gate',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const set = await changes.maintenances.setGateMaintenance(scope, userId, {
          pageId,
          gateName: args.gateName,
          title: args.title,
          expectedMinutes: args.expectedMinutes,
          componentIds: args.componentIds,
        });
        return asJson({ changed: true, gateMaintenance: settingOf(set) });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export async function deleteGateMaintenance(
  deps: StatusWriteToolDeps,
  args: GateOnlyArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(
      deps,
      ctx,
      args,
      statusWords('change status pages', 'Removing a gate that announces maintenance'),
    );
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const pages = await changes.pages.listPages(scope);
    const listed = await Promise.all(
      pages.map(async page => ({ page, rows: await changes.maintenances.listGateMaintenances(scope, page.id) })),
    );
    const [found] = listed.flatMap(({ page, rows }) =>
      rows.filter(row => row.id === args.gateMaintenanceId).map(row => ({ page, row })),
    );
    if (found === undefined) {
      throw new StatusEntityNotFoundError('gate maintenance', args.gateMaintenanceId);
    }
    const { page, row } = found;
    const change = { tool: StatusGateMaintenanceTools.delete, ...scope, from: boundOf(row) };
    const question = [
      `Stop the gate "${row.gateName}" announcing maintenance on the status page ${pageLabel(page)}, as you?`,
      `It announces "${row.title}" for ${String(row.expectedMinutes)} minutes now. Windows it already started go on.`,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Stop announcing',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        await changes.maintenances.deleteGateMaintenance(scope, userId, row.id);
        return asJson({ changed: true, deletedGateMaintenanceId: row.id });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

const CONFIRMED =
  'The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes.';

export function registerStatusGateMaintenanceTools(server: McpServer, deps: StatusWriteToolDeps): void {
  server.registerTool(
    StatusGateMaintenanceTools.search,
    {
      title: 'List the gates that announce maintenance',
      description:
        "A status page's gates that announce maintenance: for each gate name, the window title, how long it is expected to last and the components it covers. Read-only.",
      inputSchema: searchInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      try {
        return asJson(await searchGateMaintenances(deps, args, userIdOf(ctx)));
      } catch (error) {
        return statusRefusal(error);
      }
    },
  );

  server.registerTool(
    StatusGateMaintenanceTools.set,
    {
      title: 'Make a gate announce maintenance',
      description: `Make a pipeline gate announce maintenance on a status page, or change what it announces, as the signed-in person: when a run resumes the gate, a window with this title starts for the components and the run's end completes it. ${CONFIRMED}`,
      inputSchema: gateToSetInput,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Setting a gate to announce maintenance'),
    },
    async (args, ctx) => await setGateMaintenance(deps, args, ctx),
  );

  server.registerTool(
    StatusGateMaintenanceTools.delete,
    {
      title: 'Stop a gate announcing maintenance',
      description: `Stop a pipeline gate announcing maintenance on a status page, as the signed-in person; windows it already started go on. ${CONFIRMED}`,
      inputSchema: gateOnlyInput,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Removing a gate that announces maintenance'),
    },
    async (args, ctx) => await deleteGateMaintenance(deps, args, ctx),
  );
}
