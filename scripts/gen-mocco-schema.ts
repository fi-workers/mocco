// Generates docs/reference/mocco.schema.json from the zod schema (single type
// source: packages/common/src/mocco-config.ts). Run via `yarn schema:gen`;
// `yarn schema:drift` re-runs this and fails CI on any diff.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { moccoConfigSchema } from '../packages/common/src/mocco-config';

const schema = {
  $id: 'https://mocco.club/mocco.schema.json',
  title: '.mocco.yml (v1)',
  ...z.toJSONSchema(moccoConfigSchema, { target: 'draft-2020-12' }),
};
writeFileSync('docs/reference/mocco.schema.json', `${JSON.stringify(schema, null, 2)}\n`);
