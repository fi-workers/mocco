// The incident changes an agent can make on a status page, as the console's incident screens make
// them: open an incident, post an update (which is how its status moves, up to resolved), replace
// the components it affects, set its postmortem, and link, unlink or re-suggest the deploys around
// it. Plus the one read the run page has: the incidents a run is linked to.
//
// Thin adapters (ADR 0025) over `IncidentService` and `CorrelationService`, the services the
// console's `status` router writes through, with the locks and refusals in `status-write.ts`.
//
// Opening an incident and posting an update are what a team says to its customers: on a published
// incident they reach the public page at once and are sent to its subscribers. So the confirmation
// shows the page, says that it is public, and quotes the text exactly as it will be published. Each
// confirmation is bound to the state it showed, so an answer given after that state changed is
// refused as a different change and the person is asked afresh:
//
// - an update, to the incident's status and its latest update; the service checks both again under
//   the incident's row lock (`IncidentMovedError`), closing the gap between the re-read and the write;
// - a new incident, to the page's newest incident, so answering the same confirmation twice opens
//   one incident, not two;
// - the components, the postmortem and a link, to what they are now.
import { createHash } from 'node:crypto';

import { Products } from '@mocco/common/project';
import {
  affectedComponentsSchema,
  incidentCreateInputSchema,
  INCIDENT_TRANSITIONS,
  IncidentRunRelations,
  IncidentStatuses,
  IncidentVisibilities,
  incidentStatusSchema,
  incidentUpdateInputSchema,
  manualIncidentRunRelationSchema,
  postmortemInputSchema,
} from '@mocco/common/status';
import { z } from 'zod';

import { StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { confirmThenApply, refused } from '@backend/transport/mcp/tools/deciding';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';
import { onePage, projectArg } from '@backend/transport/mcp/tools/status';
import {
  componentName,
  openStatusChange,
  pageLabel,
  reachOf,
  requireStatusChanges,
  statusRefusal,
  statusWords,
  statusWriteChallenge,
} from '@backend/transport/mcp/tools/status-write';

import type { ProjectInScope } from '@backend/domain/mcp/ProjectScope';
import type { IncidentUpdateRow } from '@backend/domain/status/repos/incident-update.repo';
import type { StatusChanges, StatusWriteToolDeps } from '@backend/transport/mcp/tools/status-write';
import type { AffectedComponent, IncidentRunDto, IncidentRunRelation, IncidentStatus } from '@mocco/common/status';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export const StatusIncidentTools = {
  create: 'mocco_status_incident_create',
  postUpdate: 'mocco_status_incident_update_post',
  setComponents: 'mocco_status_incident_components_set',
  setPostmortem: 'mocco_status_incident_postmortem_set',
  linkRun: 'mocco_status_incident_run_link',
  unlinkRun: 'mocco_status_incident_run_unlink',
  correlate: 'mocco_status_incident_runs_correlate',
  runIncidents: 'mocco_status_run_incidents_list',
} as const;

/** How much of the latest update a confirmation quotes. */
const EXCERPT = 200;

const incidentArg = z.uuid().describe('The incident, as `mocco_status_incidents_search` returns it.');
const runArg = z
  .uuid()
  .describe('The run, as `mocco_runs_search` or `mocco_status_incidents_get` (detailed) gives it.');
const componentsArg = affectedComponentsSchema.describe(
  'The components it affects and how badly (`degraded`, `partial_outage`, `major_outage`), by id as `mocco_status_pages_get` gives them.',
);

const newIncidentInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  pageId: z.uuid().optional().describe('The status page. Omit it when the project has exactly one.'),
  title: incidentCreateInputSchema.shape.title.describe('The title the page shows.'),
  severity: incidentCreateInputSchema.shape.severity.describe('`minor`, `major` or `critical`.'),
  status: incidentCreateInputSchema.shape.status.describe(
    'Its first status: `investigating` (the default), `identified` or `monitoring`. Never `resolved`.',
  ),
  body: incidentCreateInputSchema.shape.body.describe('The first update, in Markdown, published as written.'),
  components: componentsArg.default([]),
});

const postUpdateInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  incidentId: incidentArg,
  status: incidentStatusSchema
    .optional()
    .describe(
      'Where the update moves it: forward (skipping is fine), back from `monitoring` to `identified`, or `resolved` to close it. Omit it to keep the status.',
    ),
  body: incidentUpdateInputSchema.shape.body.describe('The update, in Markdown, published as written.'),
});

const affectedComponentsInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  incidentId: incidentArg,
  components: componentsArg.describe(
    'Every component it affects from now on, replacing the list; `[]` for none. By id as `mocco_status_pages_get` gives them.',
  ),
});

const postmortemInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  incidentId: incidentArg,
  postmortem: postmortemInputSchema.shape.postmortem.describe(
    'The whole postmortem in Markdown, replacing the one it has; `null` clears it.',
  ),
});

const linkRunInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  incidentId: incidentArg,
  runId: runArg,
  relation: manualIncidentRunRelationSchema.describe(
    '`manual` (the default): a deploy that bears on it; `fix`: the run that resolved it.',
  ),
});

const unlinkRunInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  incidentId: incidentArg,
  runId: runArg,
});
const correlateInput = z.object({ workspaceId: workspaceArg, projectId: projectArg, incidentId: incidentArg });
const runIncidentsInput = z.object({ workspaceId: workspaceArg, runId: runArg });

export type CreateIncidentArgs = z.infer<typeof newIncidentInput>;
export type PostIncidentUpdateArgs = z.infer<typeof postUpdateInput>;
export type SetIncidentComponentsArgs = z.infer<typeof affectedComponentsInput>;
export type SetPostmortemArgs = z.infer<typeof postmortemInput>;
export type LinkRunArgs = z.infer<typeof linkRunInput>;
export type UnlinkRunArgs = z.infer<typeof unlinkRunInput>;
export type CorrelateArgs = z.infer<typeof correlateInput>;
export type RunIncidentsArgs = z.infer<typeof runIncidentsInput>;

/** The latest update, by the rule the service checks it by: the latest time, then the larger id. */
function latestOf(updates: readonly IncidentUpdateRow[]): IncidentUpdateRow | undefined {
  return updates.reduce<IncidentUpdateRow | undefined>((latest, update) => {
    if (latest === undefined) {
      return update;
    }
    const at = update.createdAt.getTime() - latest.createdAt.getTime();
    return at > 0 || (at === 0 && update.id > latest.id) ? update : latest;
  }, undefined);
}

function excerptOf(text: string) {
  // eslint-disable-next-line sonarjs/null-dereference -- a string parameter, never null
  const cut = text.slice(0, EXCERPT);
  return cut === text ? text : `${cut}…`;
}

/** A component list in a stable order, so the same list binds the same confirmation. */
const sortedComponents = (components: readonly AffectedComponent[]) =>
  components
    .map(each => ({ componentId: each.componentId, impact: each.impact }))
    .toSorted((a, b) => a.componentId.localeCompare(b.componentId));

function componentLines(components: readonly AffectedComponent[], names: ReadonlyMap<string, { name: string }>) {
  return components.length === 0
    ? 'none'
    : components.map(each => `${componentName(names, each.componentId)} (${each.impact})`).join(', ');
}

/** The page's components by id; a component of another page reads like one that does not exist. */
async function pageComponents(changes: StatusChanges, scope: ProjectInScope, pageId: string) {
  const read = await changes.pages.getPage(scope, pageId);
  return { page: read.page, names: new Map(read.components.map(each => [each.id, each] as const)) };
}

function assertOnPage(names: ReadonlyMap<string, unknown>, components: readonly { componentId: string }[]) {
  const missing = components.find(each => !names.has(each.componentId));
  if (missing !== undefined) {
    throw new StatusEntityNotFoundError('component', missing.componentId);
  }
}

/** The incident with its page and that page's components. */
async function incidentInPage(changes: StatusChanges, scope: ProjectInScope, incidentId: string) {
  const read = await changes.incidents.get(scope, incidentId);
  return { ...read, ...(await pageComponents(changes, scope, read.incident.pageId)) };
}

const incidentLabel = (incident: { title: string; id: string }) => `"${incident.title}" (${incident.id})`;

export async function createIncident(
  deps: StatusWriteToolDeps,
  args: CreateIncidentArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords('open incidents', 'Opening an incident'));
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const pageId = await onePage({ statusPages: changes.pages }, scope, args.pageId);
    const { page, names } = await pageComponents(changes, scope, pageId);
    assertOnPage(names, args.components);
    const [newest] = await changes.incidents.list(scope, pageId, false);
    // Bound to the page's newest incident: once this one is opened, the same answer is refused.
    const change = {
      tool: StatusIncidentTools.create,
      ...scope,
      pageId,
      page: { slug: page.slug, title: page.title },
      newestIncidentId: newest?.id ?? null,
      title: args.title,
      severity: args.severity,
      status: args.status,
      body: args.body,
      components: args.components,
    };
    const question = [
      `Open this incident on the status page ${pageLabel(page)}, as you?`,
      `PUBLIC: it goes on the page at once, and the page's subscribers are sent it.`,
      `Title: ${args.title}`,
      `Severity: ${args.severity}`,
      `Status: ${args.status}`,
      `Affects: ${componentLines(args.components, names)}`,
      'First update, published exactly as written:',
      '',
      args.body,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Publish this incident',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const incident = await changes.incidents.create(scope, userId, {
          pageId,
          title: args.title,
          severity: args.severity,
          status: args.status,
          body: args.body,
          components: args.components,
        });
        return asJson({
          created: true,
          incident: {
            id: incident.id,
            pageId: incident.pageId,
            title: incident.title,
            status: incident.status,
            severity: incident.severity,
            visibility: incident.visibility,
            startedAt: incident.startedAt,
          },
        });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

/** Where an incident in `from` may move with an update: the same status, or a legal step. */
const movesFrom = (from: IncidentStatus) => [from, ...INCIDENT_TRANSITIONS[from]];

export async function postIncidentUpdate(
  deps: StatusWriteToolDeps,
  args: PostIncidentUpdateArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(
      deps,
      ctx,
      args,
      statusWords('post incident updates', 'Posting an incident update'),
    );
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const { incident, updates, page } = await incidentInPage(changes, scope, args.incidentId);
    const from = incident.status;
    if (from === IncidentStatuses.resolved) {
      return refused(
        `Incident ${incidentLabel(incident)} is resolved; a resolved incident is closed and takes no updates.`,
      );
    }
    const to = args.status ?? from;
    if (!movesFrom(from).includes(to)) {
      return refused(
        `An incident can't go from ${from} to ${to}. From ${from} an update may keep it ${from} or move it to ${INCIDENT_TRANSITIONS[from].join(', ')}.`,
      );
    }
    const latest = latestOf(updates);
    // Bound to the status and the latest update shown: if anyone posts first, ask again.
    const change = {
      tool: StatusIncidentTools.postUpdate,
      ...scope,
      incidentId: incident.id,
      from,
      latestUpdateId: latest?.id ?? null,
      to,
      body: args.body,
    };
    const question = [
      `Post this update to incident ${incidentLabel(incident)}, as you?`,
      reachOf(incident, page),
      latest === undefined
        ? `Now: ${from}`
        : `Now: ${from}; latest update ${latest.createdAt.toISOString()}: "${excerptOf(latest.bodyMd)}"`,
      to === from ? `Status stays: ${from}` : `Status: ${from} → ${to}`,
      ...(to === IncidentStatuses.resolved
        ? ['Resolving closes the incident: no update can follow, and the components it affects stop counting it.']
        : []),
      'Update, exactly as written:',
      '',
      args.body,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: to === IncidentStatuses.resolved ? 'Resolve with this update' : 'Post this update',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const posted = await changes.incidents.postUpdate(
          scope,
          userId,
          incident.id,
          { status: to, body: args.body },
          { status: from, latestUpdateId: latest?.id ?? null },
        );
        return asJson({
          posted: true,
          incident: {
            id: posted.incident.id,
            status: posted.incident.status,
            visibility: posted.incident.visibility,
            resolvedAt: posted.incident.resolvedAt,
          },
          update: { id: posted.update.id, status: posted.update.status, createdAt: posted.update.createdAt },
        });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export async function setIncidentComponents(
  deps: StatusWriteToolDeps,
  args: SetIncidentComponentsArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords('change incidents', 'Changing an incident'));
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const { incident, components, page, names } = await incidentInPage(changes, scope, args.incidentId);
    assertOnPage(names, args.components);
    const now = sortedComponents(components);
    const asked = sortedComponents(args.components);
    if (JSON.stringify(now) === JSON.stringify(asked)) {
      return asJson({
        changed: false,
        incidentId: incident.id,
        reason: 'It affects exactly these components already.',
      });
    }
    const change = { tool: StatusIncidentTools.setComponents, ...scope, incidentId: incident.id, from: now, to: asked };
    const question = [
      `Change the components incident ${incidentLabel(incident)} affects, as you?`,
      incident.visibility === IncidentVisibilities.published
        ? `PUBLIC: the status page ${pageLabel(page)} shows the new impacts at once. Subscribers are not sent anything for it.`
        : reachOf(incident, page),
      `Now: ${componentLines(now, names)}`,
      `Becomes: ${componentLines(asked, names)}`,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Change the affected components',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        await changes.incidents.setComponents(scope, userId, incident.id, asked);
        return asJson({ changed: true, incidentId: incident.id, components: asked });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

/** What a confirmation binds a postmortem to: its hash, never its text, and null for none. */
const postmortemHash = (postmortem: string | null) =>
  postmortem === null ? null : createHash('sha256').update(postmortem).digest('hex');

export async function setPostmortem(
  deps: StatusWriteToolDeps,
  args: SetPostmortemArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords('change incidents', 'Changing an incident'));
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const { incident } = await changes.incidents.get(scope, args.incidentId);
    const current = incident.postmortemMd;
    const next = args.postmortem === '' ? null : args.postmortem;
    if (current === next) {
      return asJson({ changed: false, incidentId: incident.id, reason: 'The postmortem is exactly this already.' });
    }
    // Bound to the postmortem shown, so an edit someone saves meanwhile is not overwritten unseen.
    const change = {
      tool: StatusIncidentTools.setPostmortem,
      ...scope,
      incidentId: incident.id,
      from: postmortemHash(current),
      to: next,
    };
    const question = [
      next === null
        ? `Clear the postmortem of incident ${incidentLabel(incident)}, as you?`
        : `Set the postmortem of incident ${incidentLabel(incident)}, as you?`,
      'Postmortems are not on the public page yet: your team reads it in the console.',
      current === null ? 'Now: none' : `Now, beginning: "${excerptOf(current)}"`,
      ...(next === null ? [] : ['Becomes, replacing it:', '', next]),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: next === null ? 'Clear the postmortem' : 'Set the postmortem',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const updated = await changes.incidents.setPostmortem(scope, userId, incident.id, next);
        return asJson({ changed: true, incidentId: updated.id, hasPostmortem: updated.postmortemMd !== null });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

/** A link as a confirmation binds it: who linked it and how. */
const linkState = (link: IncidentRunDto | undefined) =>
  link === undefined ? null : { relation: link.relation, linkedByUserId: link.linkedByUserId };

const runLabel = (runId: string, link: IncidentRunDto | undefined) =>
  link?.run === null || link?.run === undefined
    ? `run ${runId}`
    : `run ${runId} (${link.run.repoFullName ?? 'no repository'} at ${link.run.commitSha ?? 'no commit'}, ${link.run.state})`;

const byWhom = (link: IncidentRunDto) => (link.linkedByUserId === null ? 'Mocco' : 'a person');

const relationWords: Record<IncidentRunRelation, string> = {
  [IncidentRunRelations.manual]: 'a deploy that bears on it',
  [IncidentRunRelations.fix]: 'the run that resolved it',
  [IncidentRunRelations.suspected]: "Mocco's suspect",
  [IncidentRunRelations.beforeWindow]: 'a release Mocco found before it',
};

export async function linkRun(
  deps: StatusWriteToolDeps,
  args: LinkRunArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(
      deps,
      ctx,
      args,
      statusWords('link deploys to incidents', 'Linking a deploy'),
    );
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const { incident } = await changes.incidents.get(scope, args.incidentId);
    const links = await changes.correlation.list(scope, incident.id);
    const existing = links.find(link => link.runId === args.runId);
    if (existing !== undefined && existing.linkedByUserId !== null && existing.relation === args.relation) {
      return asJson({
        changed: false,
        incidentId: incident.id,
        runId: args.runId,
        reason: `It is linked as ${args.relation} already.`,
      });
    }
    const change = {
      tool: StatusIncidentTools.linkRun,
      ...scope,
      incidentId: incident.id,
      runId: args.runId,
      relation: args.relation,
      from: linkState(existing),
    };
    const question = [
      `Link ${runLabel(args.runId, existing)} to incident ${incidentLabel(incident)} as ${args.relation} (${relationWords[args.relation]}), as you?`,
      existing === undefined
        ? 'It is not linked now.'
        : `Now: linked as ${existing.relation} (${relationWords[existing.relation]}) by ${byWhom(existing)}; this replaces it.`,
      'Linked deploys stay in the console; nothing reaches the public page.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Link this run',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const link = await changes.correlation.link(scope, userId, {
          incidentId: incident.id,
          runId: args.runId,
          relation: args.relation,
        });
        return asJson({ changed: true, incidentId: incident.id, link });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export async function unlinkRun(
  deps: StatusWriteToolDeps,
  args: UnlinkRunArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(
      deps,
      ctx,
      args,
      statusWords('link deploys to incidents', 'Unlinking a deploy'),
    );
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const { incident } = await changes.incidents.get(scope, args.incidentId);
    const links = await changes.correlation.list(scope, incident.id);
    const existing = links.find(link => link.runId === args.runId);
    if (existing === undefined) {
      throw new StatusEntityNotFoundError('run link', args.runId);
    }
    const change = {
      tool: StatusIncidentTools.unlinkRun,
      ...scope,
      incidentId: incident.id,
      runId: args.runId,
      from: linkState(existing),
    };
    const question = [
      `Unlink ${runLabel(args.runId, existing)} from incident ${incidentLabel(incident)}, as you?`,
      `Now: linked as ${existing.relation} (${relationWords[existing.relation]}) by ${byWhom(existing)}.`,
      'Recomputing the suggestions later may suggest a release of it again.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Unlink this run',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        await changes.correlation.unlink(scope, userId, { incidentId: incident.id, runId: args.runId });
        return asJson({ changed: true, incidentId: incident.id, unlinkedRunId: args.runId });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export async function correlateIncident(
  deps: StatusWriteToolDeps,
  args: CorrelateArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(
      deps,
      ctx,
      args,
      statusWords('link deploys to incidents', 'Suggesting deploys'),
    );
    if ('content' in opened) {
      return opened;
    }
    const { scope, confirmations, changes } = opened;
    const { incident } = await changes.incidents.get(scope, args.incidentId);
    const links = await changes.correlation.list(scope, incident.id);
    const suggested = links
      .filter(link => link.linkedByUserId === null)
      .map(link => link.runId)
      .toSorted((a, b) => Number(a > b) - Number(a < b));
    const byPeople = links.length - suggested.length;
    // Bound to the suggestions shown, which are what it replaces.
    const change = { tool: StatusIncidentTools.correlate, ...scope, incidentId: incident.id, suggested };
    const question = [
      `Recompute Mocco's suggested deploys for incident ${incidentLabel(incident)}, as you?`,
      `Its ${String(suggested.length)} suggestions are replaced by the releases from two hours before it started to five minutes after; the ${String(byPeople)} runs people linked stay.`,
      'Suggestions stay in the console; nothing reaches the public page.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Recompute the suggestions',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const result = await changes.correlation.correlate(scope, incident.id);
        return asJson({ changed: true, incidentId: incident.id, suggested: result.suggested });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

/** The incidents a run is linked to, across the workspace's projects, as the run's page lists them. */
export async function listRunIncidents(deps: StatusWriteToolDeps, args: RunIncidentsArgs, userId: string) {
  const changes = requireStatusChanges(deps);
  const workspaceId = await deps.projects.resolveWorkspace(userId, args.workspaceId, Products.status);
  const incidents = await changes.correlation.incidentsForRun(workspaceId, args.runId);
  return { runId: args.runId, incidents };
}

const changing = { readOnlyHint: false, openWorldHint: false } as const;
const CONFIRMED =
  'The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes.';

export function registerStatusIncidentTools(server: McpServer, deps: StatusWriteToolDeps): void {
  server.registerTool(
    StatusIncidentTools.create,
    {
      title: 'Open a status incident',
      description: `Open an incident on a status page as the signed-in person, with its title, severity, first status, first update and the components it affects. It is public at once: it goes on the page and is sent to the page's subscribers. ${CONFIRMED} The confirmation quotes exactly what will be published.`,
      inputSchema: newIncidentInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: false },
      scopeChallenge: statusWriteChallenge('Opening an incident'),
    },
    async (args, ctx) => await createIncident(deps, args, ctx),
  );

  server.registerTool(
    StatusIncidentTools.postUpdate,
    {
      title: 'Post a status incident update',
      description: `Post an update to an incident as the signed-in person; the update is how its status moves (investigating → identified → monitoring → resolved; resolved closes it). On a published incident it is public at once and sent to the page's subscribers; on a draft it stays in the console. ${CONFIRMED} The confirmation shows the status now and its latest update, and is refused if anyone posts before the answer.`,
      inputSchema: postUpdateInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: false },
      scopeChallenge: statusWriteChallenge('Posting an incident update'),
    },
    async (args, ctx) => await postIncidentUpdate(deps, args, ctx),
  );

  server.registerTool(
    StatusIncidentTools.setComponents,
    {
      title: 'Set the components an incident affects',
      description: `Replace the components an incident affects and how badly, as the signed-in person; on a published incident the page shows the new impacts at once. ${CONFIRMED}`,
      inputSchema: affectedComponentsInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Changing an incident'),
    },
    async (args, ctx) => await setIncidentComponents(deps, args, ctx),
  );

  server.registerTool(
    StatusIncidentTools.setPostmortem,
    {
      title: "Set an incident's postmortem",
      description: `Set or clear an incident's postmortem (Markdown), replacing the one it has, as the signed-in person. Postmortems are not on the public page yet. ${CONFIRMED}`,
      inputSchema: postmortemInput,
      annotations: { ...changing, destructiveHint: true, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Changing an incident'),
    },
    async (args, ctx) => await setPostmortem(deps, args, ctx),
  );

  server.registerTool(
    StatusIncidentTools.linkRun,
    {
      title: 'Link a deploy to an incident',
      description: `Link a run of the workspace to an incident as the signed-in person: \`manual\` for a deploy that bears on it, \`fix\` for the run that resolved it; a suggestion for the run becomes this link. ${CONFIRMED}`,
      inputSchema: linkRunInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Linking a deploy'),
    },
    async (args, ctx) => await linkRun(deps, args, ctx),
  );

  server.registerTool(
    StatusIncidentTools.unlinkRun,
    {
      title: 'Unlink a deploy from an incident',
      description: `Remove a run's link to an incident, Mocco's suggestion or a person's, as the signed-in person. ${CONFIRMED}`,
      inputSchema: unlinkRunInput,
      annotations: { ...changing, destructiveHint: true, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Unlinking a deploy'),
    },
    async (args, ctx) => await unlinkRun(deps, args, ctx),
  );

  server.registerTool(
    StatusIncidentTools.correlate,
    {
      title: "Recompute an incident's suggested deploys",
      description: `Replace Mocco's suggested deploys for an incident with the releases around its start (two hours before to five minutes after); runs people linked stay. ${CONFIRMED}`,
      inputSchema: correlateInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Suggesting deploys'),
    },
    async (args, ctx) => await correlateIncident(deps, args, ctx),
  );

  server.registerTool(
    StatusIncidentTools.runIncidents,
    {
      title: 'List the incidents a run is linked to',
      description:
        "The status incidents a run of the workspace is linked to, across its projects, newest first: each with its page, title, status, severity, the link's relation (`suspected`, `before_window`, `manual`, `fix`) and Mocco's score. Read-only.",
      inputSchema: runIncidentsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      try {
        return asJson(await listRunIncidents(deps, args, userIdOf(ctx)));
      } catch (error) {
        return statusRefusal(error);
      }
    },
  );
}
