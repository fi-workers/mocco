// Pipeline service — persists a parsed `.mocco.yml` as an immutable version
// snapshot. Constructor injection (see WorkspaceService.ts); no static state.
import { createHash } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { pipelines, pipelineVersions } from '../db/schema';

import { MoccoConfigSchemaError } from './errors';

import type { MoccoConfigParser } from './MoccoConfigParser';
import type { Db } from '../db/client';

export class PipelineService {
  constructor(
    private readonly db: Db,
    private readonly parser: MoccoConfigParser,
  ) {}

  /** The version matching a content hash — used to fetch the pre-existing row on a dedup no-op insert. */
  private async findVersionByHash(pipelineId: string, contentHash: string) {
    const [v] = await this.db
      .select()
      .from(pipelineVersions)
      .where(and(eq(pipelineVersions.pipelineId, pipelineId), eq(pipelineVersions.contentHash, contentHash)));
    return v ?? null;
  }

  /** Most recent version for a pipeline, `createdAt` desc with `id` as a tiebreaker for same-instant inserts. */
  private async latestVersion(pipelineId: string) {
    const [v] = await this.db
      .select()
      .from(pipelineVersions)
      .where(eq(pipelineVersions.pipelineId, pipelineId))
      .orderBy(desc(pipelineVersions.createdAt), desc(pipelineVersions.id));
    return v ?? null;
  }

  /**
   * Parse and persist a `.mocco.yml` source. Upserts the pipeline by
   * (workspace, name) and adds a version snapshot, deduped by content hash —
   * submitting the same source again returns the existing version untouched.
   * @throws {MoccoConfigSchemaError} when `source` fails YAML decoding or schema validation.
   */
  async submit(workspaceId: string, source: string) {
    const parsed = this.parser.parse(source);
    if (!parsed.ok) throw new MoccoConfigSchemaError();
    const { config: definition } = parsed;
    const contentHash = createHash('sha256').update(JSON.stringify(definition)).digest('hex');

    const [pipeline] = await this.db
      .insert(pipelines)
      .values({ workspaceId, name: definition.pipeline })
      .onConflictDoUpdate({ target: [pipelines.workspaceId, pipelines.name], set: { updatedAt: new Date() } })
      .returning();
    if (!pipeline) throw new Error('pipeline upsert returned no row');

    const [inserted] = await this.db
      .insert(pipelineVersions)
      .values({ workspaceId, pipelineId: pipeline.id, rawYaml: source, definition, contentHash })
      .onConflictDoNothing({ target: [pipelineVersions.pipelineId, pipelineVersions.contentHash] })
      .returning();
    const version = inserted ?? (await this.findVersionByHash(pipeline.id, contentHash));
    return { pipeline, version };
  }

  /** Pipelines belonging to a workspace. */
  async list(workspaceId: string) {
    return await this.db.select().from(pipelines).where(eq(pipelines.workspaceId, workspaceId));
  }

  /** A pipeline and its latest version, or null when it does not exist (or belongs to another workspace). */
  async get(workspaceId: string, id: string) {
    const [pipeline] = await this.db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.workspaceId, workspaceId), eq(pipelines.id, id)));
    if (!pipeline) return null;
    return { pipeline, version: await this.latestVersion(id) };
  }
}
