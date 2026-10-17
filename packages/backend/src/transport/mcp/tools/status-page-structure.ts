// The page structure an agent can change, as the console's page screens change it: create a page
// and change its title or address, and add, change and delete component groups and components.
// Deleting a page stays in the console: it deletes every incident, window and component on it,
// and has no undo.
//
// Thin adapters (ADR 0025) over `StatusPageService`, the service the console's `status` router
// writes through, with the locks and refusals in `status-write.ts`. Each of these shows on the
// public page at once, so the confirmation says so. Each is bound to the state it showed: a change
// to the page, group or component as it was, and a new group or component to the page's current
// ones, so answering the same confirmation twice adds one.
import { STATUS_PAGE_SLUG_PATTERN, StatusLimits } from '@mocco/common/status';
import { z } from 'zod';

import { StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { confirmThenApply, refused } from '@backend/transport/mcp/tools/deciding';
import { asJson, workspaceArg } from '@backend/transport/mcp/tools/runs';
import { onePage, projectArg } from '@backend/transport/mcp/tools/status';
import { componentIn } from '@backend/transport/mcp/tools/status-pages';
import {
  byText,
  openStatusChange,
  pageLabel,
  statusRefusal,
  statusWords,
  statusWriteChallenge,
} from '@backend/transport/mcp/tools/status-write';

import type { ProjectInScope } from '@backend/domain/mcp/ProjectScope';
import type { StatusChanges, StatusWriteToolDeps } from '@backend/transport/mcp/tools/status-write';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export const StatusStructureTools = {
  createPage: 'mocco_status_page_create',
  updatePage: 'mocco_status_page_update',
  createGroup: 'mocco_status_group_create',
  updateGroup: 'mocco_status_group_update',
  deleteGroup: 'mocco_status_group_delete',
  createComponent: 'mocco_status_component_create',
  updateComponent: 'mocco_status_component_update',
  deleteComponent: 'mocco_status_component_delete',
} as const;

const name = z.string().trim().min(1).max(StatusLimits.nameMax);
const slugArg = z
  .string()
  .regex(STATUS_PAGE_SLUG_PATTERN)
  .describe(
    'The public address label: lowercase letters, digits and inner hyphens, 1 to 40 characters. Unique across Mocco.',
  );
const pageArg = z.uuid().optional().describe('The status page. Omit it when the project has exactly one.');
const positionArg = z.int().min(0).optional().describe('Where it sits, from 0 at the top. Omit it for the end.');
const groupArg = z.uuid().describe('The group, by id as `mocco_status_pages_get` (detailed) gives it.');
const componentArg = z.uuid().describe('The component, by id as `mocco_status_pages_get` gives it.');
const descriptionArg = z
  .string()
  .trim()
  .max(StatusLimits.descriptionMax)
  .nullable()
  .optional()
  .describe('A line under its name on the page; `null` for none.');
const groupIdArg = z.uuid().nullable().optional().describe('The group it sits in, on the same page; `null` for none.');

const pageToCreateInput = z.object({ workspaceId: workspaceArg, projectId: projectArg, slug: slugArg, title: name });
const pageToChangeInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  pageId: pageArg,
  slug: slugArg.optional(),
  title: name.optional(),
});
const groupToCreateInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  pageId: pageArg,
  name,
  position: positionArg,
});
const groupToChangeInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  groupId: groupArg,
  name: name.optional(),
  position: positionArg,
});
const groupOnlyInput = z.object({ workspaceId: workspaceArg, projectId: projectArg, groupId: groupArg });
const componentToCreateInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  pageId: pageArg,
  name,
  description: descriptionArg,
  groupId: groupIdArg,
  position: positionArg,
});
const componentToChangeInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  componentId: componentArg,
  name: name.optional(),
  description: descriptionArg,
  groupId: groupIdArg,
  position: positionArg,
});
const componentOnlyInput = z.object({ workspaceId: workspaceArg, projectId: projectArg, componentId: componentArg });

export type CreatePageArgs = z.infer<typeof pageToCreateInput>;
export type UpdatePageArgs = z.infer<typeof pageToChangeInput>;
export type CreateGroupArgs = z.infer<typeof groupToCreateInput>;
export type UpdateGroupArgs = z.infer<typeof groupToChangeInput>;
export type GroupOnlyArgs = z.infer<typeof groupOnlyInput>;
export type CreateComponentArgs = z.infer<typeof componentToCreateInput>;
export type UpdateComponentArgs = z.infer<typeof componentToChangeInput>;
export type ComponentOnlyArgs = z.infer<typeof componentOnlyInput>;

const PUBLIC = 'PUBLIC: the page shows it at once.';
const CHANGE_PAGES = 'change status pages';
const sortedIds = (rows: readonly { id: string }[]) => rows.map(row => row.id).toSorted(byText);

/** The group among the project's pages, with its page and that page's components. */
async function groupIn(changes: StatusChanges, scope: ProjectInScope, groupId: string) {
  const pages = await changes.pages.listPages(scope);
  const read = await Promise.all(pages.map(async listed => await changes.pages.getPage(scope, listed.id)));
  const found = read.find(({ groups }) => groups.some(each => each.id === groupId));
  const group = found?.groups.find(each => each.id === groupId);
  if (found === undefined || group === undefined) {
    throw new StatusEntityNotFoundError('group', groupId);
  }
  return { page: found.page, group, members: found.components.filter(each => each.groupId === groupId) };
}

const groupName = (groups: readonly { id: string; name: string }[], groupId: string | null | undefined) =>
  groupId === null || groupId === undefined ? 'none' : (groups.find(each => each.id === groupId)?.name ?? groupId);

export async function createPage(
  deps: StatusWriteToolDeps,
  args: CreatePageArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords(CHANGE_PAGES, 'Creating a status page'));
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const change = { tool: StatusStructureTools.createPage, ...scope, slug: args.slug, title: args.title };
    const question = [
      `Create a status page "${args.title}" at address ${args.slug}, as you?`,
      'PUBLIC: it is published at that address at once, empty until it has components.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Create this page',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const page = await changes.pages.createPage(scope, userId, { slug: args.slug, title: args.title });
        return asJson({ created: true, page: { id: page.id, slug: page.slug, title: page.title } });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export async function updatePage(
  deps: StatusWriteToolDeps,
  args: UpdatePageArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords(CHANGE_PAGES, 'Changing a status page'));
    if ('content' in opened) {
      return opened;
    }
    const { scope, confirmations, changes } = opened;
    if (args.slug === undefined && args.title === undefined) {
      return refused('Say what to change: a new `title`, a new `slug`, or both.');
    }
    const pageId = await onePage({ statusPages: changes.pages }, scope, args.pageId);
    const { page } = await changes.pages.getPage(scope, pageId);
    const next = { slug: args.slug ?? page.slug, title: args.title ?? page.title };
    if (next.slug === page.slug && next.title === page.title) {
      return asJson({ changed: false, pageId, reason: 'The page has this title and address already.' });
    }
    const change = {
      tool: StatusStructureTools.updatePage,
      ...scope,
      pageId,
      from: { slug: page.slug, title: page.title },
      to: next,
    };
    const question = [
      `Change the status page ${pageLabel(page)}, as you?`,
      PUBLIC,
      ...(next.title === page.title ? [] : [`Title: ${page.title} → ${next.title}`]),
      ...(next.slug === page.slug
        ? []
        : [`Address: ${page.slug} → ${next.slug}. Links to the old address stop working.`]),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Change this page',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const updated = await changes.pages.updatePage(scope, pageId, next);
        return asJson({ changed: true, page: { id: updated.id, slug: updated.slug, title: updated.title } });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export async function createGroup(
  deps: StatusWriteToolDeps,
  args: CreateGroupArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords(CHANGE_PAGES, 'Adding a component group'));
    if ('content' in opened) {
      return opened;
    }
    const { scope, confirmations, changes } = opened;
    const pageId = await onePage({ statusPages: changes.pages }, scope, args.pageId);
    const { page, groups } = await changes.pages.getPage(scope, pageId);
    const change = {
      tool: StatusStructureTools.createGroup,
      ...scope,
      pageId,
      groupIds: sortedIds(groups),
      name: args.name,
      position: args.position ?? null,
    };
    const question = [
      `Add a component group "${args.name}" to the status page ${pageLabel(page)}, as you?`,
      PUBLIC,
      `Position: ${args.position === undefined ? 'at the end' : String(args.position)}`,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Add this group',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const group = await changes.pages.createGroup(scope, pageId, {
          name: args.name,
          ...(args.position !== undefined && { position: args.position }),
        });
        return asJson({ created: true, group: { id: group.id, name: group.name, position: group.position } });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export async function updateGroup(
  deps: StatusWriteToolDeps,
  args: UpdateGroupArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords(CHANGE_PAGES, 'Changing a component group'));
    if ('content' in opened) {
      return opened;
    }
    const { scope, confirmations, changes } = opened;
    const { page, group } = await groupIn(changes, scope, args.groupId);
    const next = { name: args.name ?? group.name, position: args.position ?? group.position };
    if (next.name === group.name && next.position === group.position) {
      return asJson({ changed: false, groupId: group.id, reason: 'The group has this name and position already.' });
    }
    const change = {
      tool: StatusStructureTools.updateGroup,
      ...scope,
      groupId: group.id,
      from: { name: group.name, position: group.position },
      to: next,
    };
    const question = [
      `Change component group "${group.name}" on the status page ${pageLabel(page)}, as you?`,
      PUBLIC,
      ...(next.name === group.name ? [] : [`Name: ${group.name} → ${next.name}`]),
      ...(next.position === group.position ? [] : [`Position: ${String(group.position)} → ${String(next.position)}`]),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Change this group',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const updated = await changes.pages.updateGroup(scope, group.id, next);
        return asJson({ changed: true, group: { id: updated.id, name: updated.name, position: updated.position } });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export async function deleteGroup(
  deps: StatusWriteToolDeps,
  args: GroupOnlyArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords(CHANGE_PAGES, 'Deleting a component group'));
    if ('content' in opened) {
      return opened;
    }
    const { scope, confirmations, changes } = opened;
    const { page, group, members } = await groupIn(changes, scope, args.groupId);
    const change = {
      tool: StatusStructureTools.deleteGroup,
      ...scope,
      groupId: group.id,
      name: group.name,
      memberIds: sortedIds(members),
    };
    const question = [
      `Delete component group "${group.name}" from the status page ${pageLabel(page)}, as you?`,
      PUBLIC,
      members.length === 0
        ? 'It has no components.'
        : `Its components stay on the page, ungrouped: ${members.map(each => each.name).join(', ')}.`,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Delete this group',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        await changes.pages.deleteGroup(scope, group.id);
        return asJson({ changed: true, deletedGroupId: group.id });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export async function createComponent(
  deps: StatusWriteToolDeps,
  args: CreateComponentArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords(CHANGE_PAGES, 'Adding a component'));
    if ('content' in opened) {
      return opened;
    }
    const { scope, confirmations, changes } = opened;
    const pageId = await onePage({ statusPages: changes.pages }, scope, args.pageId);
    const { page, groups, components } = await changes.pages.getPage(scope, pageId);
    if (args.groupId !== undefined && args.groupId !== null && groups.every(each => each.id !== args.groupId)) {
      throw new StatusEntityNotFoundError('group', args.groupId);
    }
    const change = {
      tool: StatusStructureTools.createComponent,
      ...scope,
      pageId,
      componentIds: sortedIds(components),
      name: args.name,
      description: args.description ?? null,
      groupId: args.groupId ?? null,
      position: args.position ?? null,
    };
    const question = [
      `Add a component "${args.name}" to the status page ${pageLabel(page)}, as you?`,
      PUBLIC,
      `Description: ${args.description ?? 'none'}`,
      `Group: ${groupName(groups, args.groupId)}`,
      'It starts operational.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Add this component',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const component = await changes.pages.createComponent(scope, pageId, {
          name: args.name,
          description: args.description ?? null,
          groupId: args.groupId ?? null,
          ...(args.position !== undefined && { position: args.position }),
        });
        return asJson({
          created: true,
          component: { id: component.id, name: component.name, groupId: component.groupId, status: component.status },
        });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export async function updateComponent(
  deps: StatusWriteToolDeps,
  args: UpdateComponentArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords(CHANGE_PAGES, 'Changing a component'));
    if ('content' in opened) {
      return opened;
    }
    const { scope, confirmations, changes } = opened;
    const { page, component, groups } = await componentIn(changes, scope, args.componentId);
    const from = {
      name: component.name,
      description: component.description,
      groupId: component.groupId,
      position: component.position,
    };
    const to = {
      name: args.name ?? from.name,
      description: args.description ?? (args.description === null ? null : from.description),
      groupId: args.groupId ?? (args.groupId === null ? null : from.groupId),
      position: args.position ?? from.position,
    };
    const lines = [
      ...(to.name === from.name ? [] : [`Name: ${from.name} → ${to.name}`]),
      ...(to.description === from.description
        ? []
        : [`Description: ${from.description ?? 'none'} → ${to.description ?? 'none'}`]),
      ...(to.groupId === from.groupId
        ? []
        : [`Group: ${groupName(groups, from.groupId)} → ${groupName(groups, to.groupId)}`]),
      ...(to.position === from.position ? [] : [`Position: ${String(from.position)} → ${String(to.position)}`]),
    ];
    if (lines.length === 0) {
      return asJson({ changed: false, componentId: component.id, reason: 'The component is exactly this already.' });
    }
    const change = { tool: StatusStructureTools.updateComponent, ...scope, componentId: component.id, from, to };
    const question = [
      `Change component "${component.name}" on the status page ${pageLabel(page)}, as you?`,
      PUBLIC,
      ...lines,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Change this component',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const updated = await changes.pages.updateComponent(scope, component.id, to);
        return asJson({
          changed: true,
          component: { id: updated.id, name: updated.name, groupId: updated.groupId, position: updated.position },
        });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export async function deleteComponent(
  deps: StatusWriteToolDeps,
  args: ComponentOnlyArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords(CHANGE_PAGES, 'Deleting a component'));
    if ('content' in opened) {
      return opened;
    }
    const { scope, confirmations, changes } = opened;
    const { page, component } = await componentIn(changes, scope, args.componentId);
    const change = {
      tool: StatusStructureTools.deleteComponent,
      ...scope,
      componentId: component.id,
      name: component.name,
      status: component.status,
    };
    const question = [
      `Delete component "${component.name}" from the status page ${pageLabel(page)}, as you?`,
      PUBLIC,
      `It shows ${component.displayedStatus} now.`,
      'It leaves every incident and maintenance window that names it and every monitor that reports on it, and its uptime history is deleted. It cannot be undone.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Delete this component',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        await changes.pages.deleteComponent(scope, component.id);
        return asJson({ changed: true, deletedComponentId: component.id });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

const CONFIRMED =
  'The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes.';
const adding = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false } as const;
const changing = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true } as const;
const deleting = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true } as const;

export function registerStatusStructureTools(server: McpServer, deps: StatusWriteToolDeps): void {
  server.registerTool(
    StatusStructureTools.createPage,
    {
      title: 'Create a status page',
      description: `Create a status page for a project, with its title and public address, as the signed-in person; it is published at that address at once. ${CONFIRMED}`,
      inputSchema: pageToCreateInput,
      annotations: adding,
      scopeChallenge: statusWriteChallenge('Creating a status page'),
    },
    async (args, ctx) => await createPage(deps, args, ctx),
  );
  server.registerTool(
    StatusStructureTools.updatePage,
    {
      title: "Change a status page's title or address",
      description: `Change a status page's title or public address, as the signed-in person; links to an old address stop working. Deleting a page stays in the console. ${CONFIRMED}`,
      inputSchema: pageToChangeInput,
      annotations: changing,
      scopeChallenge: statusWriteChallenge('Changing a status page'),
    },
    async (args, ctx) => await updatePage(deps, args, ctx),
  );
  server.registerTool(
    StatusStructureTools.createGroup,
    {
      title: 'Add a component group',
      description: `Add a component group to a status page, as the signed-in person. ${CONFIRMED}`,
      inputSchema: groupToCreateInput,
      annotations: adding,
      scopeChallenge: statusWriteChallenge('Adding a component group'),
    },
    async (args, ctx) => await createGroup(deps, args, ctx),
  );
  server.registerTool(
    StatusStructureTools.updateGroup,
    {
      title: 'Rename or move a component group',
      description: `Rename a component group or move it up or down its page, as the signed-in person. ${CONFIRMED}`,
      inputSchema: groupToChangeInput,
      annotations: changing,
      scopeChallenge: statusWriteChallenge('Changing a component group'),
    },
    async (args, ctx) => await updateGroup(deps, args, ctx),
  );
  server.registerTool(
    StatusStructureTools.deleteGroup,
    {
      title: 'Delete a component group',
      description: `Delete a component group, as the signed-in person; its components stay on the page, ungrouped. ${CONFIRMED}`,
      inputSchema: groupOnlyInput,
      annotations: deleting,
      scopeChallenge: statusWriteChallenge('Deleting a component group'),
    },
    async (args, ctx) => await deleteGroup(deps, args, ctx),
  );
  server.registerTool(
    StatusStructureTools.createComponent,
    {
      title: 'Add a component',
      description: `Add a component to a status page (a name, an optional description and group), as the signed-in person; it starts operational. ${CONFIRMED}`,
      inputSchema: componentToCreateInput,
      annotations: adding,
      scopeChallenge: statusWriteChallenge('Adding a component'),
    },
    async (args, ctx) => await createComponent(deps, args, ctx),
  );
  server.registerTool(
    StatusStructureTools.updateComponent,
    {
      title: 'Change a component',
      description: `Rename a component, change its description or group, or move it, as the signed-in person; name only what changes. Its status is set with \`mocco_status_component_status_set\`. ${CONFIRMED}`,
      inputSchema: componentToChangeInput,
      annotations: changing,
      scopeChallenge: statusWriteChallenge('Changing a component'),
    },
    async (args, ctx) => await updateComponent(deps, args, ctx),
  );
  server.registerTool(
    StatusStructureTools.deleteComponent,
    {
      title: 'Delete a component',
      description: `Delete a component from its status page, as the signed-in person: it leaves the incidents, maintenance windows and monitors that name it, and its uptime history is deleted. It cannot be undone. ${CONFIRMED}`,
      inputSchema: componentOnlyInput,
      annotations: deleting,
      scopeChallenge: statusWriteChallenge('Deleting a component'),
    },
    async (args, ctx) => await deleteComponent(deps, args, ctx),
  );
}
