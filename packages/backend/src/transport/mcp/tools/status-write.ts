// What every status page change over MCP shares: the services it writes through, the locks it
// opens with, and how it words a refusal and a page.
//
// A status page is what a team says to its customers, so every change takes the locks of every
// changing tool (`openDecision`, `confirmThenApply` in `deciding.ts`): the `status:write` scope,
// stepped up for the first time a tool needs it, the workspace's opt-in, and a confirmation the
// person answers in their client, showing exactly what would change and, where the change reaches
// the public page or its subscribers, saying so. Then the console's own rule: any member of a
// project with the status product may change its status pages (`productProcedure(Products.status)`),
// checked by `ProjectScope` with the caller's own id, so another tenant's page, incident or window
// reads exactly like one that does not exist.
//
// The services record every change in the audit log as the person who made it, as the console
// does, so a change made through an agent reads like one made in the console.
import { McpScopes } from '@mocco/common/mcp';
import { IncidentVisibilities } from '@mocco/common/status';

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { ToolUnavailableError } from '@backend/domain/mcp/errors';
import { openDecision, refused, requireScope } from '@backend/transport/mcp/tools/deciding';
import { resolveStatusProject } from '@backend/transport/mcp/tools/status';

import type { ProjectInScope, ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { CorrelationService } from '@backend/domain/status/CorrelationService';
import type { IncidentService } from '@backend/domain/status/IncidentService';
import type { LocationService } from '@backend/domain/status/LocationService';
import type { MaintenanceService } from '@backend/domain/status/MaintenanceService';
import type { MonitorService } from '@backend/domain/status/MonitorService';
import type { IncidentRow } from '@backend/domain/status/repos/incident.repo';
import type { StatusPageRow } from '@backend/domain/status/repos/page.repo';
import type { StatusPageService } from '@backend/domain/status/StatusPageService';
import type { Confirmations } from '@backend/transport/mcp/confirmation';
import type { DecidingToolDeps, DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { CallToolResult, ScopeChallengeHandler, ServerContext } from '@modelcontextprotocol/server';

/** The services status changes write through: the ones the console's `status` router calls. */
export interface StatusChanges {
  pages: Pick<
    StatusPageService,
    | 'listPages'
    | 'getPage'
    | 'setComponentStatus'
    | 'createPage'
    | 'updatePage'
    | 'createGroup'
    | 'updateGroup'
    | 'deleteGroup'
    | 'createComponent'
    | 'updateComponent'
    | 'deleteComponent'
  >;
  incidents: Pick<IncidentService, 'list' | 'get' | 'create' | 'postUpdate' | 'setComponents' | 'setPostmortem'>;
  correlation: Pick<CorrelationService, 'list' | 'correlate' | 'link' | 'unlink' | 'incidentsForRun'>;
  maintenances: Pick<
    MaintenanceService,
    'list' | 'schedule' | 'cancel' | 'listGateMaintenances' | 'setGateMaintenance' | 'deleteGateMaintenance'
  >;
  monitors: Pick<MonitorService, 'list' | 'find' | 'create' | 'update' | 'pause' | 'resume' | 'delete'>;
  /** For the names of the locations a monitor runs at. */
  locations: Pick<LocationService, 'list'>;
}

export interface StatusWriteToolDeps extends DecidingToolDeps {
  /** Absent on a server that does not compose the status product; the tools then say so. */
  statusChanges?: StatusChanges;
  projects: Pick<ProjectScope, 'resolve' | 'resolveWorkspace'>;
}

/** One permission for every status change, worded as the consent screen words it. */
const STATUS_WRITE = {
  name: McpScopes.statusWrite,
  allows: 'change your status pages, incidents, maintenance and monitors',
} as const;

/** How a status change names itself in its refusals. */
export const statusWords = (verb: string, doing: string): DecisionWords => ({
  verb,
  doing,
  scope: STATUS_WRITE,
  instead: 'make the change in the Status page section of the Mocco console',
});

/** The step-up a status change declares: a token without `status:write` is challenged for it. */
export const statusWriteChallenge = (doing: string): ScopeChallengeHandler =>
  requireScope(McpScopes.statusWrite, `${doing} needs your permission for this app to change your status pages as you`);

export function requireStatusChanges(deps: StatusWriteToolDeps): StatusChanges {
  if (deps.statusChanges === undefined) {
    throw new ToolUnavailableError('Status pages are not available on this Mocco server');
  }
  return deps.statusChanges;
}

export interface OpenStatusChange {
  userId: string;
  scope: ProjectInScope;
  confirmations: Confirmations;
  changes: StatusChanges;
}

/**
 * The checks every status change makes before it asks: scope, opt-in and a signing key
 * (`openDecision`), the services being here, and the project with the status product on.
 */
export async function openStatusChange(
  deps: StatusWriteToolDeps,
  ctx: ServerContext,
  asked: { workspaceId?: string; projectId?: string },
  words: DecisionWords,
): Promise<OpenStatusChange | CallToolResult> {
  const opened = await openDecision(deps, ctx, asked.workspaceId, words);
  if ('content' in opened) {
    return opened;
  }
  const changes = requireStatusChanges(deps);
  const scope = await resolveStatusProject(deps, opened.userId, {
    workspaceId: opened.workspaceId,
    projectId: asked.projectId,
  });
  return { userId: opened.userId, scope, confirmations: opened.confirmations, changes };
}

/**
 * The services' refusals, as the model reads them. They already word them for a person
 * ("Status incident … was not found", "An incident can't go from resolved to identified");
 * anything outside these families is a real failure and is rethrown.
 */
export function statusRefusal(error: unknown): CallToolResult {
  if (
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof BadRequestError ||
    error instanceof ForbiddenError
  ) {
    return refused(error.message);
  }
  throw error;
}

/** Ascending by code unit, like a database's C collation: ids in a fixed order for a binding. */
export const byText = (a: string, b: string) => Number(a > b) - Number(a < b);

/** A page as a confirmation names it. */
export const pageLabel = (page: Pick<StatusPageRow, 'title' | 'slug'>) => `"${page.title}" (address ${page.slug})`;

/** Where an incident's words go: the public page and its subscribers, or nowhere outside the console. */
export const reachOf = (incident: Pick<IncidentRow, 'visibility'>, page: Pick<StatusPageRow, 'title' | 'slug'>) =>
  incident.visibility === IncidentVisibilities.published
    ? `PUBLIC: it goes on the status page ${pageLabel(page)} at once and is sent to the page's subscribers.`
    : 'The incident is a draft: it stays in the console, and nothing reaches the public page or its subscribers.';

/** A component as a confirmation names it, from the page's own components. */
export const componentName = (components: ReadonlyMap<string, { name: string }>, componentId: string) =>
  components.get(componentId)?.name ?? componentId;
