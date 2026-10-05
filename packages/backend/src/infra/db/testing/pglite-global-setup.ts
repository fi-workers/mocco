// Vitest global setup: migrate one PGlite per run and hand its data directory to the
// workers, so each createTestDb loads a migrated database instead of re-running every
// migration (the bulk of a pglite suite's hook time).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildMigratedTemplate } from '@backend/infra/db/testing/pglite';

import type { TestProject } from 'vitest/node';

export async function setup(project: TestProject) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mocco-pglite-'));
  const file = path.join(dir, 'template.tar');
  const dataDir = await buildMigratedTemplate();
  await writeFile(file, Buffer.from(await dataDir.arrayBuffer()));
  project.provide('pgliteTemplatePath', file);
  return async () => {
    await rm(dir, { recursive: true, force: true });
  };
}
