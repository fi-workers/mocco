// GitHub-specific fixed sets (constants over enums). These mirror an EXTERNAL
// contract (GitHub's own webhook/App taxonomy) verbatim, so they live in the
// github/ leaf — never in the provider-neutral `domain/integration/constants.ts`.
// Each set is the single source of truth: the zod schemas in `webhook-events.ts`
// build their `z.enum(...)` from these objects, and every comparison site
// references the constant instead of a raw string literal.

/** `X-GitHub-Event` header values we branch on in `provider.ts#parseWebhook`. */
export const GithubWebhookEvents = {
  push: 'push',
  installation: 'installation',
  installation_repositories: 'installation_repositories',
} as const;
export type GithubWebhookEvent = (typeof GithubWebhookEvents)[keyof typeof GithubWebhookEvents];

/** `installation` webhook payload `action` values (GitHub App lifecycle). */
export const GithubInstallationActions = {
  created: 'created',
  deleted: 'deleted',
  suspend: 'suspend',
  unsuspend: 'unsuspend',
  new_permissions_accepted: 'new_permissions_accepted',
} as const;
export type GithubInstallationAction = (typeof GithubInstallationActions)[keyof typeof GithubInstallationActions];

/** `setup_action` query param on the GitHub App post-install redirect. */
export const GithubSetupActions = {
  install: 'install',
  request: 'request',
} as const;
export type GithubSetupAction = (typeof GithubSetupActions)[keyof typeof GithubSetupActions];

/** Discriminant of `ParsedWebhook` (`webhook-events.ts`). `ignored` is ours, not
 * GitHub's — added alongside the GitHub-derived kinds so the whole discriminated
 * union has one shared source of truth. */
export const WebhookKinds = {
  push: 'push',
  installation: 'installation',
  installation_repositories: 'installation_repositories',
  ignored: 'ignored',
} as const;
export type WebhookKind = (typeof WebhookKinds)[keyof typeof WebhookKinds];

/** GitHub webhook request headers read in `transport/ext/app.ts`. */
export const GithubHeaders = {
  delivery: 'x-github-delivery',
  event: 'x-github-event',
  signature: 'x-hub-signature-256',
} as const;
export type GithubHeader = (typeof GithubHeaders)[keyof typeof GithubHeaders];

/** HMAC algorithm for webhook signature verification. GitHub prefixes the header
 * value with `<algorithm>=`; derive the prefix from this instead of duplicating
 * the literal. */
export const SIGNATURE_ALGORITHM = 'sha256';
