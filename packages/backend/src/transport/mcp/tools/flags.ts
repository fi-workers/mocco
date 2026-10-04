// `mocco_flags_*` — which flags a project has, what each serves where, and which flag
// changes are waiting for approval. Read-only: changing a flag is a decision, and the
// deciding tools have their own machinery (scope, opt-in, confirmation) that these do not
// borrow.
//
// Thin adapters (ADR 0025) over `FlagService`, the service the console's flags router
// reads through. Flags are project-scoped, so every call first goes through
// `ProjectScope`, which makes the checks the console's `productProcedure` makes —
// membership, the flags product, the project in that workspace — with the caller's own
// id. The filtering and paging here only narrow what the service returned for that
// project; they decide nothing.
import { ChangesetStates, FlagLifecycles, FlagManagers } from '@mocco/common/flags';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { FlagEnvironmentNotFoundError, FlagNotFoundError } from '@backend/domain/flags/errors';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { FlagService } from '@backend/domain/flags/FlagService';
import type { ProjectInScope, ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { ChangesetState, FlagConfigDto } from '@mocco/common/flags';
import type { McpServer } from '@modelcontextprotocol/server';

export interface FlagToolDeps {
  flags: Pick<FlagService, 'listFlags' | 'listEnvironments' | 'history'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const projectArg = z
  .uuid()
  .optional()
  .describe('The project the flags belong to. Omit it when the workspace has exactly one.');

const responseFormatArg = z
  .enum(['concise', 'detailed'])
  .default('concise')
  .describe('`concise` is keys and on/off per environment; `detailed` adds variants, rules and rollouts.');

const limitArg = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);

const searchInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  query: z.string().min(1).optional().describe('Text the flag key or description contains (case-insensitive).'),
  lifecycle: z
    .enum([FlagLifecycles.temporary, FlagLifecycles.permanent])
    .optional()
    .describe('Only `temporary` flags (meant to be removed) or `permanent` ones.'),
  repoManaged: z
    .boolean()
    .optional()
    .describe('Only flags defined in the repository (`.mocco/flags.yml`), or only those defined in the console.'),
  limit: limitArg,
  after: z.string().optional().describe("Cursor: the previous page's last `key`."),
  responseFormat: responseFormatArg,
});

const readInput = z.object({
  flagKey: z.string().min(1).describe('The flag key, as `mocco_flags_search` returns it.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
  responseFormat: responseFormatArg,
});

const changesetStates = Object.values(ChangesetStates) as [ChangesetState, ...ChangesetState[]];

const changesetSearchInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  environment: z
    .string()
    .min(1)
    .optional()
    .describe('Only this environment, by key (e.g. `production`) or id. Omit it for every environment.'),
  state: z
    .enum(changesetStates)
    .default(ChangesetStates.pending)
    .describe('Only changesets in this state. The default — pending — is what is waiting for approval.'),
  limit: limitArg,
  before: z.string().optional().describe("Cursor: the previous answer's `nextBefore`, as it was given."),
  responseFormat: z
    .enum(['concise', 'detailed'])
    .default('concise')
    .describe('`concise` names what changes; `detailed` adds the full diff, the ops and the pinned gate.'),
});

export type SearchFlagsArgs = z.infer<typeof searchInput>;
export type GetFlagArgs = z.infer<typeof readInput>;
export type SearchChangesetsArgs = z.infer<typeof changesetSearchInput>;

type Environment = Awaited<ReturnType<FlagService['listEnvironments']>>[number];

/** What a flag serves in one environment, said in one line. */
function serving(config: FlagConfigDto): string {
  if (config.killed) {
    return `killed: serves ${config.offVariant}`;
  }
  if (!config.enabled) {
    return "disabled: callers get their code's default";
  }
  const fallthrough =
    config.rollout === null
      ? config.defaultVariant
      : `a rollout of ${config.rollout.map(entry => entry.variant).join('/')}`;
  return config.rules.length === 0
    ? `serves ${fallthrough}`
    : `${config.rules.length} rule(s), otherwise serves ${fallthrough}`;
}

/** A flag's state in each environment, in the project's environment order. */
function perEnvironment(
  environments: readonly Environment[],
  configs: readonly FlagConfigDto[],
  responseFormat: 'concise' | 'detailed',
) {
  return environments.flatMap(environment => {
    const config = configs.find(each => each.environmentId === environment.id);
    if (config === undefined) {
      return [];
    }
    return [
      {
        environment: environment.key,
        enabled: config.enabled,
        killed: config.killed,
        serving: serving(config),
        ...(responseFormat === 'detailed' && {
          environmentId: environment.id,
          // A protected environment's changes wait for approval (ADR 0023).
          isProtected: environment.changeGate !== null,
          defaultVariant: config.defaultVariant,
          offVariant: config.offVariant,
          rules: config.rules,
          rollout: config.rollout,
          version: config.version,
        }),
      },
    ];
  });
}

const resolveFlagsProject = async (deps: FlagToolDeps, userId: string, asked: Partial<ProjectInScope>) =>
  await deps.projects.resolve(userId, asked, Products.flags);

export async function searchFlags(deps: FlagToolDeps, args: SearchFlagsArgs, userId: string) {
  const { workspaceId, projectId } = await resolveFlagsProject(deps, userId, args);
  const [flags, environments] = await Promise.all([
    deps.flags.listFlags(workspaceId, projectId),
    deps.flags.listEnvironments(workspaceId, projectId),
  ]);
  const needle = args.query?.toLowerCase();
  // The service returns them ordered by key, which is what makes `after` a cursor.
  const matching = flags.filter(
    flag =>
      (args.after === undefined || flag.key > args.after) &&
      (needle === undefined ||
        flag.key.toLowerCase().includes(needle) ||
        (flag.description?.toLowerCase().includes(needle) ?? false)) &&
      (args.lifecycle === undefined || flag.lifecycle === args.lifecycle) &&
      (args.repoManaged === undefined || (flag.managedBy === FlagManagers.repo) === args.repoManaged),
  );
  const page = matching.slice(0, args.limit);
  return {
    projectId,
    flags: page.map(flag => ({
      key: flag.key,
      type: flag.type,
      lifecycle: flag.lifecycle,
      repoManaged: flag.managedBy === FlagManagers.repo,
      environments: perEnvironment(environments, flag.configs, 'concise').map(each =>
        args.responseFormat === 'detailed' ? each : { environment: each.environment, enabled: each.enabled },
      ),
      ...(args.responseFormat === 'detailed' && {
        description: flag.description,
        clientVisible: flag.clientVisible,
        variants: flag.variants,
        createdAt: flag.createdAt,
      }),
    })),
    // Present when there is more: pass it back as `after` for the next page.
    ...(matching.length > page.length && { nextAfter: page.at(-1)?.key }),
  };
}

export async function getFlag(deps: FlagToolDeps, args: GetFlagArgs, userId: string) {
  const { workspaceId, projectId } = await resolveFlagsProject(deps, userId, args);
  const [flags, environments] = await Promise.all([
    deps.flags.listFlags(workspaceId, projectId),
    deps.flags.listEnvironments(workspaceId, projectId),
  ]);
  const flag = flags.find(each => each.key === args.flagKey);
  if (flag === undefined) {
    throw new FlagNotFoundError(args.flagKey);
  }
  const isRepoManaged = flag.managedBy === FlagManagers.repo;
  return {
    projectId,
    key: flag.key,
    type: flag.type,
    description: flag.description,
    lifecycle: flag.lifecycle,
    // Flags as code: its definition and rules change through `.mocco/flags.yml`, not the
    // console; only its kill switch works from both.
    repoManaged: isRepoManaged,
    ...(isRepoManaged && { managedIn: '.mocco/flags.yml' }),
    clientVisible: flag.clientVisible,
    variants: args.responseFormat === 'detailed' ? flag.variants : Object.keys(flag.variants),
    environments: perEnvironment(environments, flag.configs, args.responseFormat),
    createdAt: flag.createdAt,
  };
}

/**
 * Where a changeset sits in newest-first order, as a string that sorts the same way.
 * The id breaks ties: changesets written in one transaction share a `createdAt`, and a
 * cursor on the time alone would skip the rest of them.
 */
const positionOf = (changeset: { createdAt: Date; id: string }) =>
  `${changeset.createdAt.toISOString()}~${changeset.id}`;

/** Compares positions by code unit, which is the order `before` filters by. */
function newestFirst(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? 1 : -1;
}

export async function searchChangesets(deps: FlagToolDeps, args: SearchChangesetsArgs, userId: string) {
  const { workspaceId, projectId } = await resolveFlagsProject(deps, userId, args);
  const environments = await deps.flags.listEnvironments(workspaceId, projectId);
  const wanted =
    args.environment === undefined
      ? environments
      : environments.filter(each => each.key === args.environment || each.id === args.environment);
  if (args.environment !== undefined && wanted.length === 0) {
    throw new FlagEnvironmentNotFoundError(args.environment);
  }
  const histories = await Promise.all(
    wanted.map(async environment => ({
      environment,
      changesets: await deps.flags.history(workspaceId, projectId, environment.id),
    })),
  );
  const matching = histories
    .flatMap(({ environment, changesets }) => changesets.map(changeset => ({ environment, changeset })))
    .filter(({ changeset }) => changeset.state === args.state)
    .map(entry => ({ ...entry, position: positionOf(entry.changeset) }))
    .filter(({ position }) => args.before === undefined || position < args.before)
    .toSorted((a, b) => newestFirst(a.position, b.position));
  const page = matching.slice(0, args.limit);
  return {
    projectId,
    changesets: page.map(({ environment, changeset }) => ({
      id: changeset.id,
      environment: environment.key,
      state: changeset.state,
      source: changeset.source,
      // What changes, without the values: the detailed shape carries those.
      changes: changeset.diff.map(entry => `${entry.subject} ${entry.key}: ${entry.field}`),
      reason: changeset.reason,
      proposedByUserId: changeset.proposedByUserId,
      // The request deciding it: `mocco_approvals_get` shows its votes and who may still vote.
      approvalRequestId: changeset.approvalRequestId,
      createdAt: changeset.createdAt,
      expiresAt: changeset.expiresAt,
      ...(args.responseFormat === 'detailed' && {
        environmentId: environment.id,
        diff: changeset.diff,
        ops: changeset.ops,
        contentHash: changeset.contentHash,
        baseVersion: changeset.baseVersion,
        appliedVersion: changeset.appliedVersion,
        commitSha: changeset.commitSha,
        requirements: changeset.requirements,
        resolvedAt: changeset.resolvedAt,
      }),
    })),
    // Present when there is more: pass it back as `before` for the next page.
    ...(matching.length > page.length && { nextBefore: page.at(-1)?.position }),
  };
}

export function registerFlagTools(server: McpServer, deps: FlagToolDeps): void {
  server.registerTool(
    'mocco_flags_search',
    {
      title: 'Find feature flags',
      description:
        'Find the feature flags of a project, by key or description text, lifecycle, or whether the repository defines them. Says whether each is on in each environment; `detailed` adds what it serves there.',
      inputSchema: searchInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchFlags(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_flags_get',
    {
      title: 'Read one feature flag',
      description:
        'One flag: its variants, what it serves in every environment, and whether `.mocco/flags.yml` manages it. Read-only — changing a flag happens in the console or the repository.',
      inputSchema: readInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getFlag(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_flags_changesets_search',
    {
      title: 'Find flag changesets',
      description:
        "Find flag changes of a project, newest first. The default — pending — is what waits for approval in a protected environment; each names the approval request deciding it. Looks at each environment's 50 most recent changesets.",
      inputSchema: changesetSearchInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchChangesets(deps, args, userIdOf(ctx))),
  );
}
