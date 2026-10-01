/** A problem the user fixes locally (config, flags, the export): printed as is. */
export class CliError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CliError';
  }
}
