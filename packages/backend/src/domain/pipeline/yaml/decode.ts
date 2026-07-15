// The ONLY file that imports the `yaml` vendor. Everything else consumes
// `decodeYaml` (injected as a `YamlDecoder`), so the vendor can be swapped by
// rewriting this file alone.
import { parse as yamlParse, YAMLParseError } from 'yaml';

import { MoccoConfigYamlError } from '@backend/domain/pipeline/errors';

/** Decode a YAML string to a plain JS value. Vendor errors become domain errors. */
export function decodeYaml(source: string): unknown {
  try {
    return yamlParse(source);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      throw new MoccoConfigYamlError(error.message, { cause: error, line: error.linePos?.[0]?.line });
    }
    throw error;
  }
}

export type YamlDecoder = typeof decodeYaml;
