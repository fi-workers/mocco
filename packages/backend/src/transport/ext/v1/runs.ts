// /v1/runs (ADR 0025, slice 1): what a key may see of the governance product — which runs
// exist, which are paused, and on what. Read-only, and secret keys only: run history is
// operational data about a team's deploys, not something a browser or an app may read.
//
// A key authenticates a **project**; a run belongs to a workspace. The bridge is the
// repositories the project links (`mocco_project_repos`), so a key sees runs of its own
// project's repositories and nothing else, even inside the same workspace.
//
// Deciding is deliberately absent. Resuming a gate or voting on an approval has to name a
// person who could have been asked, and a key is not a person — that surface is MCP, which
// authenticates one (ADR 0002).
import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { runStateSchema } from '@mocco/common/execution';
import { Hono } from 'hono';
import { z } from 'zod';

import { requireKey } from '@backend/transport/ext/v1/middleware';
import { problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { RunService } from '@backend/domain/execution/RunService';
import type * as schema from '@backend/infra/db/schema';
import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';

export interface RunReadDeps {
  runs: Pick<RunService, 'searchInProject' | 'getInProject'>;
}

/** Page size. Capped so one call can't pull a workspace's history into a model's context. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const searchQuerySchema = z.object({
  state: runStateSchema.optional(),
  repoId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  /** Cursor: the `createdAt` of the previous page's last run. */
  before: z.coerce.date().optional(),
});

/** Revalidate on every use: a run's state is the thing the caller is watching change. */
const CACHE_CONTROL = 'private, no-cache';

/** The run fields both answers carry. `currentIndex` is where the cursor sits: on a
 * paused run it is the gate item that is holding it. */
const runOf = (run: typeof schema.runs.$inferSelect) => ({
  id: run.id,
  state: run.state,
  currentIndex: run.currentIndex,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
});

export function createRunReadRoutes(deps: V1Deps, runs: RunReadDeps): Hono<V1Env> {
  const app = new Hono<V1Env>();

  // The runs of this project's repositories, newest first.
  app.get('/runs', requireKey(deps, { scope: ApiScopes.runsRead, kinds: [ApiKeyKinds.secret] }), async c => {
    const query = searchQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return problemResponse(problemOf(400, ProblemCodes.badRequest, 'The query is not valid'));
    }
    const { workspaceId, projectId } = c.var.principal;
    const rows = await runs.runs.searchInProject(workspaceId, projectId, query.data);
    c.header('Cache-Control', CACHE_CONTROL);
    return c.json({
      runs: rows.map(row => ({
        ...runOf(row.run),
        repo: { id: row.repo.id, name: row.repo.name },
        commit: { id: row.commit.id, sha: row.commit.sha, branch: row.commit.branch, message: row.commit.message },
      })),
      // Present when the page was full: pass it back as `before` for the next one.
      nextBefore: rows.length === query.data.limit ? rows.at(-1)?.run.createdAt : undefined,
    });
  });

  // One run with its steps and gates — enough to say why it is paused and on what.
  app.get('/runs/:runId', requireKey(deps, { scope: ApiScopes.runsRead, kinds: [ApiKeyKinds.secret] }), async c => {
    const { workspaceId, projectId } = c.var.principal;
    const found = await runs.runs.getInProject(workspaceId, projectId, c.req.param('runId'));
    if (found === undefined) {
      return problemResponse(problemOf(404, ProblemCodes.notFound, 'That run was not found'));
    }
    c.header('Cache-Control', CACHE_CONTROL);
    return c.json({
      ...runOf(found.run),
      repo: { id: found.repo.id, name: found.repo.name },
      commit: {
        id: found.commit.id,
        sha: found.commit.sha,
        branch: found.commit.branch,
        message: found.commit.message,
      },
      steps: found.steps.map(step => ({
        index: step.stepIndex,
        name: step.name,
        executor: step.executor,
        status: step.status,
        logsUrl: step.logsUrl,
        updatedAt: step.updatedAt,
      })),
      // What a paused run is waiting for: the `pending` gate is the one holding it.
      gates: found.gates.map(gate => ({
        itemIndex: gate.itemIndex,
        name: gate.name,
        state: gate.state,
        requirements: gate.requirements,
        resolvedAt: gate.resolvedAt,
      })),
    });
  });

  return app;
}
