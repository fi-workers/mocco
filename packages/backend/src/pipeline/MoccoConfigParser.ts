import { moccoConfigSchema, type MoccoConfig } from '@mocco/common/mocco-config';

import { MoccoConfigYamlError } from './errors';

import type { YamlDecoder } from './yaml/decode';

export interface MoccoConfigIssue {
  path: string;
  message: string;
  code: string;
  line?: number;
}

export type ParseResult =
  { ok: true; config: MoccoConfig } | { ok: false; stage: 'yaml' | 'schema'; issues: MoccoConfigIssue[] };

/** Parses a `.mocco.yml` string into a validated `MoccoConfig`, or a discriminated
 * failure describing whether the YAML or the schema stage rejected it. */
export class MoccoConfigParser {
  constructor(private readonly decode: YamlDecoder) {}

  /**
   * Decode then validate a `.mocco.yml` source string.
   * @returns `{ ok: true, config }` on success, or `{ ok: false, stage, issues }`
   * naming which stage (`yaml` decoding or `schema` validation) rejected it.
   */
  parse(source: string): ParseResult {
    let value: unknown;
    try {
      value = this.decode(source);
    } catch (error) {
      if (error instanceof MoccoConfigYamlError) {
        return {
          ok: false,
          stage: 'yaml',
          issues: [{ path: '', message: error.message, code: 'yaml-syntax', line: error.line }],
        };
      }
      throw error;
    }

    const result = moccoConfigSchema.safeParse(value);
    if (result.success) return { ok: true, config: result.data };

    return {
      ok: false,
      stage: 'schema',
      issues: result.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    };
  }
}
