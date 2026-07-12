import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProvider, type Provider } from '../auth/provider';
import { createTestDb, type TestDb } from '../db/testing/pglite';

import { MoccoConfigSchemaError } from './errors';
import { MoccoConfigParser } from './MoccoConfigParser';
import { PipelineService } from './PipelineService';
import { decodeYaml } from './yaml/decode';

const validYaml = `version: 1
pipeline: deploy
steps:
  - run: build
    executor: generic`;

const otherValidYaml = `version: 1
pipeline: deploy
steps:
  - run: build
    executor: generic
  - run: test
    executor: generic`;

const invalidYaml = 'version: 1\npipeline: p\nsteps: []';

describe('PipelineService', () => {
  let t: TestDb;
  let auth: Provider;
  let service: PipelineService;

  const signUpAndCreateWorkspace = async (email: string) => {
    const { headers: resHeaders, response } = await auth.api.signUpEmail({
      body: { email, password: 'fixture-password-1', name: 'fixture-user' },
      returnHeaders: true,
    });
    const cookie = resHeaders.get('set-cookie') ?? '';
    const headers = new Headers({ cookie });
    const org = await auth.api.createOrganization({ body: { name: 'Acme', slug: `acme-${email}` }, headers });
    return { userId: response.user.id, workspaceId: org?.id ?? '' };
  };

  beforeEach(async () => {
    t = await createTestDb();
    auth = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    service = new PipelineService(t.db, new MoccoConfigParser(decodeYaml));
  });
  afterEach(async () => {
    await t.close();
  });

  it('submit persists a pipeline and its first version', async () => {
    const { workspaceId } = await signUpAndCreateWorkspace('owner@example.com');

    const { pipeline, version } = await service.submit(workspaceId, validYaml);

    expect(pipeline.name).toBe('deploy');
    expect(version?.definition).toMatchObject({ pipeline: 'deploy' });
  });

  it('list returns the pipelines for a workspace', async () => {
    const { workspaceId } = await signUpAndCreateWorkspace('owner@example.com');
    await service.submit(workspaceId, validYaml);

    const pipelines = await service.list(workspaceId);

    expect(pipelines).toHaveLength(1);
  });

  it('get returns the pipeline with its latest version', async () => {
    const { workspaceId } = await signUpAndCreateWorkspace('owner@example.com');
    const { pipeline } = await service.submit(workspaceId, validYaml);

    const result = await service.get(workspaceId, pipeline.id);

    expect(result).not.toBeNull();
    expect(result?.pipeline.id).toBe(pipeline.id);
    expect(result?.version?.definition).toMatchObject({
      steps: [{ run: 'build', executor: 'generic' }],
    });
  });

  it('submitting the identical yaml again is idempotent (same version, no duplicate row)', async () => {
    const { workspaceId } = await signUpAndCreateWorkspace('owner@example.com');
    const first = await service.submit(workspaceId, validYaml);
    const second = await service.submit(workspaceId, validYaml);

    expect(second.version?.id).toBe(first.version?.id);

    const pipelines = await service.list(workspaceId);
    expect(pipelines).toHaveLength(1);
    const rows = await t.db.select().from(t.schema.pipelineVersions);
    expect(rows).toHaveLength(1);
  });

  it('submitting a different valid yaml adds a new version, still one pipeline', async () => {
    const { workspaceId } = await signUpAndCreateWorkspace('owner@example.com');
    const first = await service.submit(workspaceId, validYaml);
    const second = await service.submit(workspaceId, otherValidYaml);

    expect(second.version?.id).not.toBe(first.version?.id);
    expect(second.pipeline.id).toBe(first.pipeline.id);

    const pipelines = await service.list(workspaceId);
    expect(pipelines).toHaveLength(1);
    const versionRows = await t.db.select().from(t.schema.pipelineVersions);
    expect(versionRows).toHaveLength(2);
    expect(new Set(versionRows.map(r => r.id))).toEqual(new Set([first.version?.id, second.version?.id]));
  });

  it('submit throws MoccoConfigSchemaError for a schema-invalid .mocco.yml', async () => {
    const { workspaceId } = await signUpAndCreateWorkspace('owner@example.com');

    await expect(service.submit(workspaceId, invalidYaml)).rejects.toThrow(MoccoConfigSchemaError);
  });

  it('list scopes pipelines to the workspace', async () => {
    const { workspaceId } = await signUpAndCreateWorkspace('owner@example.com');
    await service.submit(workspaceId, validYaml);
    const { workspaceId: otherWorkspaceId } = await signUpAndCreateWorkspace('other@example.com');

    const pipelines = await service.list(otherWorkspaceId);

    expect(pipelines).toHaveLength(0);
  });
});
