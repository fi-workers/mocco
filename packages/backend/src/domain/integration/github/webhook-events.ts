import { z } from 'zod';

import { GithubInstallationActions } from '@backend/domain/integration/github/constants';

import type { GithubInstallationAction, WebhookKinds } from '@backend/domain/integration/github/constants';

// GitHub-namespaced webhook payload schemas. These are NOT neutral — they mirror
// GitHub App webhook taxonomy verbatim and live next to the GitHub adapter (never
// in @mocco/common). Only the fields we consume are declared; unknown fields pass
// through untouched (zod objects ignore extras by default). Parse with
// `safeParse` at the boundary. The `action`/`kind` enums are built FROM the
// constants in `./constants` (single source of truth) — never a duplicated
// literal list.

const repoRef = z.object({ id: z.number(), name: z.string(), owner: z.object({ login: z.string() }) });

export const pushEventSchema = z.object({
  ref: z.string(), // refs/heads/<branch>
  /** The branch head after the push (all zeros when the branch was deleted). */
  after: z.string().optional(),
  installation: z.object({ id: z.number() }),
  repository: repoRef,
  /** Who pushed (git identity) and the GitHub account that did: proposers for a gate (#145). */
  pusher: z.object({ name: z.string(), email: z.string().nullish() }).optional(),
  sender: z.object({ id: z.number(), login: z.string() }).optional(),
  head_commit: z.object({ id: z.string(), author: z.object({ name: z.string(), email: z.string() }) }).nullish(),
  commits: z.array(
    z.object({
      id: z.string(), // sha
      message: z.string(),
      timestamp: z.string(),
      author: z.object({ name: z.string(), email: z.string() }),
    }),
  ),
});

const installationActionValues = Object.values(GithubInstallationActions) as [
  GithubInstallationAction,
  ...GithubInstallationAction[],
];

export const installationEventSchema = z.object({
  action: z.enum(installationActionValues),
  installation: z.object({ id: z.number(), account: z.object({ login: z.string(), id: z.number() }) }),
  sender: z.object({ login: z.string(), id: z.number() }),
});

export const installationRepositoriesEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
});

/** A pull request opened or moved (#146: the flags plan check). `action` stays a plain
 * string: GitHub sends many more than the ones we act on, and those are ignored, not refused. */
export const pullRequestEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  repository: repoRef,
  pull_request: z.object({
    number: z.number(),
    head: z.object({ sha: z.string() }),
    /** `ref` is the bare branch name (no `refs/heads/`). */
    base: z.object({ ref: z.string(), sha: z.string() }),
  }),
});

export type ParsedWebhook =
  | { kind: typeof WebhookKinds.push; data: z.infer<typeof pushEventSchema> }
  | { kind: typeof WebhookKinds.installation; data: z.infer<typeof installationEventSchema> }
  | { kind: typeof WebhookKinds.installation_repositories; data: z.infer<typeof installationRepositoriesEventSchema> }
  | { kind: typeof WebhookKinds.pull_request; data: z.infer<typeof pullRequestEventSchema> }
  | { kind: typeof WebhookKinds.ignored; eventType: string };
