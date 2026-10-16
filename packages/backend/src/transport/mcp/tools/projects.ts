// `mocco_projects_search` and the tools that lay a workspace out for a product: create a
// project, add an app (a build target) to it, and turn a product line on. These are the
// first steps of the console's Overview page, so an agent setting a product up — OTA
// hosting for a React Native app, say — can start from an empty workspace instead of
// sending the person to the console for them.
//
// Every change is behind the same locks as the other changing tools (`openDecision`,
// `confirmThenApply` in `deciding.ts`): its own `projects:write` scope, stepped up for per
// tool, the workspace's opt-in, and a confirmation round trip that shows exactly what would
// be created. Then the console's own rule, which is membership: any member may create a
// project, add an app and turn a product on (`protectedWorkspaceProcedure`,
// `protectedProjectProcedure`). Archiving, removing an app and turning a product off stay in
// the console.
//
// Thin adapters (ADR 0025) over `ProjectService` and `ProductEnablementService`, the services
// the console's `project` and `product` routers write through.
import { McpScopes } from '@mocco/common/mcp';
import {
  appPlatformLabels,
  appPlatformSchema,
  PROJECT_HANDLE_PATTERN,
  Products,
  productSchema,
} from '@mocco/common/project';
import { z } from 'zod';

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { ProjectUnclearError, ToolUnavailableError } from '@backend/domain/mcp/errors';
import { confirmThenApply, openDecision, refused, requireScope } from '@backend/transport/mcp/tools/deciding';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import type { ProductEnablementService } from '@backend/domain/project/ProductEnablementService';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { DecidingToolDeps } from '@backend/transport/mcp/tools/deciding';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface ProjectToolDeps extends DecidingToolDeps {
  /** Absent on a server that does not compose projects; the tools then say so. */
  projectSetup?: {
    projects: Pick<ProjectService, 'list' | 'requireProject' | 'listApps' | 'create' | 'addApp'>;
    products: Pick<ProductEnablementService, 'list' | 'enable'>;
  };
  scope: WorkspaceScope;
}

type ProjectSetup = NonNullable<ProjectToolDeps['projectSetup']>;

export const ProjectTools = {
  search: 'mocco_projects_search',
  create: 'mocco_projects_create',
  addApp: 'mocco_projects_apps_add',
  enableProduct: 'mocco_products_enable',
} as const;

const WORDS = {
  verb: 'set up projects',
  doing: 'Setting up projects',
  scope: { name: McpScopes.projectsWrite, allows: 'create projects, add apps and turn on products as you' },
} as const;

const projectArg = z
  .uuid()
  .optional()
  .describe('The project, as `mocco_projects_search` lists it. Omit it when the workspace has exactly one.');

const searchInput = z.object({
  workspaceId: workspaceArg,
  query: z.string().min(1).optional().describe('Text the project name or handle contains (case-insensitive).'),
  includeArchived: z.boolean().default(false),
});

const projectCreateInput = z.object({
  workspaceId: workspaceArg,
  name: z.string().trim().min(1).max(80).describe('What people call it, e.g. `ShowYourTime`.'),
  handle: z
    .string()
    .regex(PROJECT_HANDLE_PATTERN)
    .describe('A short lowercase id unique in the workspace, e.g. `showyourtime`. It appears in URLs.'),
  defaultLocale: z
    .string()
    .min(2)
    .max(35)
    .optional()
    .describe("The project's source language as a tag (`en`, `ko`). Omit it for the default."),
});

const appToAddInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  platform: appPlatformSchema.describe(
    '`react_native` for an app that ships OTA updates; `ios` and `android` for the store apps a version policy covers; `web`; `server`.',
  ),
  name: z.string().trim().min(1).max(80).describe('What people call it, e.g. `ShowYourTime app`.'),
  bundleId: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe('The bundle id or application id, when the platform has one (e.g. `com.acme.app`).'),
  storeAppId: z.string().min(1).max(255).optional().describe("The App Store app id, for an iOS app's store link."),
});

const enableInput = z.object({
  workspaceId: workspaceArg,
  product: productSchema.describe('The product line to turn on, e.g. `ota`, `flags`, `status`, `helpcenter`.'),
});

export type SearchProjectsArgs = z.infer<typeof searchInput>;
export type CreateProjectArgs = z.infer<typeof projectCreateInput>;
export type AddProjectAppArgs = z.infer<typeof appToAddInput>;
export type EnableProductArgs = z.infer<typeof enableInput>;

function requireSetup(deps: ProjectToolDeps): ProjectSetup {
  if (deps.projectSetup === undefined) {
    throw new ToolUnavailableError('Projects are not available on this Mocco server');
  }
  return deps.projectSetup;
}

/** The services' refusals, as the model reads them; anything else is a real failure. */
function projectRefusal(error: unknown): CallToolResult {
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

/**
 * The project a call is about, inside the workspace: the named one (a foreign or unknown id
 * reads the same), or the only active one. The product is not checked — adding an app is
 * what comes before any product uses it, as in the console's `protectedProjectProcedure`.
 */
async function projectIn(setup: ProjectSetup, workspaceId: string, projectId: string | undefined) {
  if (projectId !== undefined) {
    return await setup.projects.requireProject(workspaceId, projectId);
  }
  const projects = await setup.projects.list(workspaceId, { includeArchived: false });
  const [only] = projects;
  if (projects.length !== 1 || only === undefined) {
    throw new ProjectUnclearError(projects.map(each => ({ id: each.id, name: each.name })));
  }
  return only;
}

/** The workspace's projects with their apps, and the products the workspace has on. Read-only. */
export async function searchProjects(deps: ProjectToolDeps, args: SearchProjectsArgs, userId: string) {
  const setup = requireSetup(deps);
  const workspaceId = await deps.scope.resolve(userId, args.workspaceId);
  const [projects, products] = await Promise.all([
    setup.projects.list(workspaceId, { includeArchived: args.includeArchived }),
    setup.products.list(workspaceId),
  ]);
  const listAppsOf = async (projectId: string) => await setup.projects.listApps(workspaceId, projectId);
  const needle = args.query?.toLowerCase();
  const matching = projects.filter(
    each =>
      needle === undefined || each.name.toLowerCase().includes(needle) || each.handle.toLowerCase().includes(needle),
  );
  return {
    workspaceId,
    products,
    projects: await Promise.all(
      matching.map(async project => {
        const apps = await listAppsOf(project.id);
        return {
          id: project.id,
          name: project.name,
          handle: project.handle,
          isArchived: project.archivedAt !== null,
          apps: apps.map(app => ({ id: app.id, platform: app.platform, name: app.name, bundleId: app.bundleId })),
        };
      }),
    ),
    ...(projects.length === 0 && {
      next: `Create one with ${ProjectTools.create}, then add its apps with ${ProjectTools.addApp}.`,
    }),
  };
}

export async function createProject(
  deps: ProjectToolDeps,
  args: CreateProjectArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, WORDS);
    if ('content' in opened) {
      return opened;
    }
    const { workspaceId, confirmations } = opened;
    const setup = requireSetup(deps);
    const values = {
      name: args.name,
      handle: args.handle,
      ...(args.defaultLocale !== undefined && { defaultLocale: args.defaultLocale }),
    };
    const change = { tool: ProjectTools.create, workspaceId, ...values };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Create this project',
      ask: async () =>
        await Promise.resolve(
          [
            'Create a project in this workspace, as you?',
            `Name: ${values.name}`,
            `Handle: ${values.handle}`,
            ...(args.defaultLocale === undefined ? [] : [`Source language: ${args.defaultLocale}`]),
            'It starts with no apps; add them next.',
          ].join('\n'),
        ),
      apply: async () => {
        const project = await setup.projects.create(workspaceId, values);
        return asJson({
          changed: true,
          project: { id: project.id, name: project.name, handle: project.handle },
          next: `Add its apps with ${ProjectTools.addApp}.`,
        });
      },
    });
  } catch (error) {
    return projectRefusal(error);
  }
}

export async function addProjectApp(
  deps: ProjectToolDeps,
  args: AddProjectAppArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, WORDS);
    if ('content' in opened) {
      return opened;
    }
    const { workspaceId, confirmations } = opened;
    const setup = requireSetup(deps);
    const project = await projectIn(setup, workspaceId, args.projectId);
    const values = {
      platform: args.platform,
      name: args.name,
      ...(args.bundleId !== undefined && { bundleId: args.bundleId }),
      ...(args.storeAppId !== undefined && { storeAppId: args.storeAppId }),
    };
    const change = { tool: ProjectTools.addApp, workspaceId, projectId: project.id, ...values };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Add this app',
      ask: async () =>
        await Promise.resolve(
          [
            'Add an app to this project, as you?',
            `Project: ${project.name} (${project.id})`,
            `App: ${values.name} (${appPlatformLabels[values.platform]})`,
            ...(args.bundleId === undefined ? [] : [`Bundle id: ${args.bundleId}`]),
            ...(args.storeAppId === undefined ? [] : [`Store app id: ${args.storeAppId}`]),
          ].join('\n'),
        ),
      apply: async () => {
        const app = await setup.projects.addApp(workspaceId, project.id, values);
        return asJson({
          changed: true,
          app: { id: app.id, projectId: app.projectId, platform: app.platform, name: app.name, bundleId: app.bundleId },
        });
      },
    });
  } catch (error) {
    return projectRefusal(error);
  }
}

export async function enableProduct(
  deps: ProjectToolDeps,
  args: EnableProductArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, WORDS);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const setup = requireSetup(deps);
    // Already on (governance always is): nothing to ask about.
    const enabled = await setup.products.list(workspaceId);
    if (args.product === Products.governance || enabled.includes(args.product)) {
      return asJson({ changed: false, product: args.product, reason: 'It is already on in this workspace.' });
    }
    const change = { tool: ProjectTools.enableProduct, workspaceId, product: args.product };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Turn this product on',
      ask: async () =>
        await Promise.resolve(
          [
            'Turn a product on for this workspace, as you?',
            `Product: ${args.product}`,
            'Every project of the workspace can use it; nothing is set up in any of them yet.',
          ].join('\n'),
        ),
      apply: async () => {
        await setup.products.enable(workspaceId, args.product, userId);
        return asJson({ changed: true, product: args.product });
      },
    });
  } catch (error) {
    return projectRefusal(error);
  }
}

const CHANGE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;
const SCOPE_CHALLENGE = requireScope(
  McpScopes.projectsWrite,
  'Setting up projects needs your permission for this app to make changes as you',
);
const CONFIRMED =
  'The person is asked to confirm in their client first. Only works where the workspace allows agents to make changes.';

export function registerProjectTools(server: McpServer, deps: ProjectToolDeps): void {
  server.registerTool(
    ProjectTools.search,
    {
      title: 'Find projects',
      description:
        "The workspace's projects by name or handle, each with its apps (platform, name, bundle id), and the product lines the workspace has on. Read-only.",
      inputSchema: searchInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      try {
        return asJson(await searchProjects(deps, args, userIdOf(ctx)));
      } catch (error) {
        return projectRefusal(error);
      }
    },
  );

  server.registerTool(
    ProjectTools.create,
    {
      title: 'Create a project',
      description: `Create a project in the workspace, as the signed-in person. ${CONFIRMED}`,
      inputSchema: projectCreateInput,
      annotations: CHANGE_ANNOTATIONS,
      scopeChallenge: SCOPE_CHALLENGE,
    },
    async (args, ctx) => await createProject(deps, args, ctx),
  );

  server.registerTool(
    ProjectTools.addApp,
    {
      title: 'Add an app to a project',
      description: `Add an app (a build target: React Native, iOS, Android, web or server) to a project, as the signed-in person. ${CONFIRMED}`,
      inputSchema: appToAddInput,
      annotations: CHANGE_ANNOTATIONS,
      scopeChallenge: SCOPE_CHALLENGE,
    },
    async (args, ctx) => await addProjectApp(deps, args, ctx),
  );

  server.registerTool(
    ProjectTools.enableProduct,
    {
      title: 'Turn a product on',
      description: `Turn a product line (such as \`ota\`) on for the workspace, as the signed-in person. Turning one off stays in the console. ${CONFIRMED}`,
      inputSchema: enableInput,
      annotations: CHANGE_ANNOTATIONS,
      scopeChallenge: SCOPE_CHALLENGE,
    },
    async (args, ctx) => await enableProduct(deps, args, ctx),
  );
}
