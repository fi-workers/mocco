import { readFile } from 'node:fs/promises';

import { Ajv } from 'ajv';

const loadSchema = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL(`flagd-schema-v0/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;

/** A validator for flagd's v0 flag-definition schema (vendored from flagd.dev, which
 * `flags.json` references `targeting.json` relative to). */
export async function flagdValidator() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema(await loadSchema('targeting.json'));
  return ajv.compile(await loadSchema('flags.json'));
}
