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

/** Domain error for a config that fails YAML decoding or the `.mocco.yml` schema.
 * Carries the parser's issues so the router (and the UI) can show the specific
 * problems inline — "the parse error IS the UX" (spec §11). */
export class MoccoConfigSchemaError extends Error {
  readonly issues: readonly { path: string; message: string }[];

  constructor(issues: readonly { path: string; message: string }[] = []) {
    super(
      issues.length > 0
        ? issues.map(issue => `${issue.path || 'root'}: ${issue.message}`).join('; ')
        : 'invalid .mocco.yml',
    );
    this.name = 'MoccoConfigSchemaError';
    this.issues = issues;
  }
}
