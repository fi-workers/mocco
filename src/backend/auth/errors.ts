// Domain errors thrown by the services in this folder. Vendor/DB failure
// interpretation happens at the vendor boundary (the service); routers only
// map these to transport codes via instanceof — no vendor knowledge outside.

/** A workspace slug is already in use. Thrown by WorkspaceService.create. */
export class SlugTakenError extends Error {
  constructor(slug: string, options?: ErrorOptions) {
    super(`workspace slug already taken: ${slug}`, options);
    this.name = 'SlugTakenError';
  }
}
