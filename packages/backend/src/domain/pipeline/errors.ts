/** Domain error for a YAML syntax failure. Carries the vendor error as `cause`
 * and, when available, the 1-based source line where parsing failed. */
export class MoccoConfigYamlError extends Error {
  readonly line?: number;

  constructor(message: string, opts: { cause: unknown; line?: number }) {
    super(message, { cause: opts.cause });
    this.name = 'MoccoConfigYamlError';
    this.line = opts.line;
  }
}

/** Domain error for a config that fails the `.mocco.yml` schema. */
export class MoccoConfigSchemaError extends Error {
  constructor(message = 'invalid .mocco.yml') {
    super(message);
    this.name = 'MoccoConfigSchemaError';
  }
}
