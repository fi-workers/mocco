// Generates the JSON Schemas of the repository files Mocco reads, from their zod
// schemas (the single type source): docs/reference/mocco.schema.json for `.mocco.yml`
// (packages/common/src/mocco-config.ts) and docs/reference/flags.schema.json for
// `.mocco/flags.yml` (packages/common/src/flags-file.ts). Run via `yarn schema:gen`;
// `yarn schema:drift` re-runs this and fails CI on any diff.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { flagsFileSchema } from '../packages/common/src/flags-file';
import { moccoConfigSchema } from '../packages/common/src/mocco-config';

const write = (path: string, schema: Record<string, unknown>) => {
  writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`);
};

write('docs/reference/mocco.schema.json', {
  $id: 'https://mocco.club/mocco.schema.json',
  title: '.mocco.yml (v1 & v2)',
  ...z.toJSONSchema(moccoConfigSchema, { target: 'draft-2020-12' }),
});
write('docs/reference/flags.schema.json', {
  $id: 'https://mocco.club/flags.schema.json',
  title: '.mocco/flags.yml (v1)',
  ...z.toJSONSchema(flagsFileSchema, { target: 'draft-2020-12', io: 'input' }),
});
