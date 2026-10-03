// `mocco_runs_*` — what is running, what is paused, and on what.
//
// Thin adapters (ADR 0025): each parses its input, resolves the workspace, calls one
// service and shapes the answer. The caller is a person, so every read is bounded by the
// workspace they are a member of — `WorkspaceScope.resolve` re-checks that on every call.
//
// Search rather than list, and `concise` by default: a tool that returns everything makes
// the model pay for a workspace's history before it finds the one run it wanted.
//
// Each tool's body is an ordinary function taking the caller's id; `registerRunTools`
// only wires them to the server and pulls that id out of the request context. The
// behaviour is then tested by calling it, not by reaching into the server's registry.
import { runStateSchema } from '@mocco/common/execution';
import { z } from 'zod';

import type { RunService } from '@backend/domain/execution/RunService';
import type { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import type { McpServer } from '@modelcontextprotocol/server';

export interface RunToolDeps {
  runs: Pick<RunService, 'searchInWorkspace' | 'get'>;
  scope: WorkspaceScope;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const workspaceArg = z
  .string()
  .optional()
  .describe('The workspace to look in. Omit it when you belong to exactly one.');

export const responseFormatArg = z
  .enum(['concise', 'detailed'])
  .default('concise')
  .describe('`concise` is ids and status; `detailed` adds the commit and the gate requirements.');

const searchInput = z.object({
  workspaceId: workspaceArg,
  state: runStateSchema.optional().describe('Only runs in this state.'),
  repoId: z.string().optional().describe('Only runs of this repository.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  before: z.string().optional().describe("Cursor: the previous page's last `createdAt`."),
  responseFormat: responseFormatArg,
});

const readInput = z.object({
  runId: z.string().describe('The run id, as `mocco_runs_search` returns it.'),
  workspaceId: workspaceArg,
  responseFormat: responseFormatArg,
});

export type SearchRunsArgs = z.infer<typeof searchInput>;
export type GetRunArgs = z.infer<typeof readInput>;

/** A paused run is waiting at the gate its cursor points to. */
const pausedOn = <T extends { itemIndex: number; state: string }>(gates: readonly T[], currentIndex: number) =>
  gates.find(gate => gate.itemIndex === currentIndex && gate.state === 'pending');

export async function searchRuns(deps: RunToolDeps, args: SearchRunsArgs, userId: string) {
  const { workspaceId, state, repoId, limit, before, responseFormat } = args;
  const workspace = await deps.scope.resolve(userId, workspaceId);
  const rows = await deps.runs.searchInWorkspace(workspace, {
    limit,
    ...(state !== undefined && { state }),
    ...(repoId !== undefined && { repoId }),
    ...(before !== undefined && { before: new Date(before) }),
  });
  return {
    runs: rows.map(row => ({
      id: row.run.id,
      state: row.run.state,
      repo: row.repo.name,
      createdAt: row.run.createdAt,
      ...(responseFormat === 'detailed' && {
        branch: row.commit.branch,
        sha: row.commit.sha,
        message: row.commit.message,
        startedAt: row.run.startedAt,
        finishedAt: row.run.finishedAt,
      }),
    })),
    // Present when the page was full: pass it back as `before` for the next one.
    ...(rows.length === limit && { nextBefore: rows.at(-1)?.run.createdAt }),
  };
}

export async function getRun(deps: RunToolDeps, args: GetRunArgs, userId: string) {
  const workspace = await deps.scope.resolve(userId, args.workspaceId);
  const { run, steps, gates } = await deps.runs.get(workspace, args.runId);
  const waiting = pausedOn(gates, run.currentIndex);
  return {
    id: run.id,
    state: run.state,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    // The single most useful fact about a paused run, stated rather than inferred.
    waitingOn: waiting === undefined ? null : { gate: waiting.name, requirements: waiting.requirements },
    steps: steps.map(step => ({
      index: step.stepIndex,
      name: step.name,
      status: step.status,
      ...(args.responseFormat === 'detailed' && { executor: step.executor, logsUrl: step.logsUrl }),
    })),
    ...(args.responseFormat === 'detailed' && {
      gates: gates.map(gate => ({
        itemIndex: gate.itemIndex,
        name: gate.name,
        state: gate.state,
        requirements: gate.requirements,
        resolvedAt: gate.resolvedAt,
      })),
    }),
  };
}

/** Where the route stores the token subject for the tools. */
export const MCP_USER_ID = 'moccoUserId';

/**
 * The authenticated person.
 *
 * `requireMcpAuth` verifies the token and hands the route its claims; the route puts the
 * subject into `authInfo.extra` (the SDK's `AuthInfo` describes the token, not the user).
 * A tool that cannot find one refuses rather than falling back to anything, because every
 * read is bounded by who is asking.
 */
export function userIdOf(ctx: { http?: { authInfo?: { extra?: Record<string, unknown> } } }): string {
  const subject = ctx.http?.authInfo?.extra?.[MCP_USER_ID];
  if (typeof subject !== 'string' || subject === '') {
    throw new Error('This tool needs a signed-in person');
  }
  return subject;
}

/** Tools answer with JSON text: the model reads it, and nothing here renders UI. */
export function asJson(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerRunTools(server: McpServer, deps: RunToolDeps): void {
  server.registerTool(
    'mocco_runs_search',
    {
      title: 'Find runs',
      description:
        'Find pipeline runs, newest first. Filter by state to answer "what is waiting" — `awaiting_gate` is a run paused for approval.',
      inputSchema: searchInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchRuns(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_runs_get',
    {
      title: 'Read one run',
      description: 'One run with its steps and gates — enough to say why it is paused and what would release it.',
      inputSchema: readInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getRun(deps, args, userIdOf(ctx))),
  );
}
