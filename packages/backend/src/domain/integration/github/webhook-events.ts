import { z } from 'zod';

import { GithubInstallationActions, GithubIssueStates } from '@backend/domain/integration/github/constants';

import type {
  GithubInstallationAction,
  GithubIssueState,
  WebhookKinds,
} from '@backend/domain/integration/github/constants';

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
const githubIssueStateValues = Object.values(GithubIssueStates) as [GithubIssueState, ...GithubIssueState[]];

export const pullRequestEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  repository: repoRef,
  pull_request: z.object({
    number: z.number(),
    head: z.object({ sha: z.string() }),
    /** `ref` is the bare branch name (no `refs/heads/`). */
    base: z.object({ ref: z.string(), sha: z.string() }),
    // What a feedback link shows (#178). Optional so a payload without them still reaches the
    // flags plan check; the link update is skipped when they're missing.
    node_id: z.string().optional(),
    title: z.string().optional(),
    html_url: z.string().optional(),
    state: z.enum(githubIssueStateValues).optional(),
    merged: z.boolean().nullish(),
    merge_commit_sha: z.string().nullish(),
    merged_at: z.string().nullish(),
  }),
});

/** An issue opened, edited, closed, reopened… (#178: feedback links). Every action is parsed;
 * the link update reads only the issue's current state. */
export const issuesEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  repository: repoRef,
  issue: z.object({
    number: z.number(),
    node_id: z.string(),
    title: z.string(),
    html_url: z.string(),
    state: z.enum(githubIssueStateValues),
  }),
});

export type ParsedWebhook =
  | { kind: typeof WebhookKinds.push; data: z.infer<typeof pushEventSchema> }
  | { kind: typeof WebhookKinds.installation; data: z.infer<typeof installationEventSchema> }
  | { kind: typeof WebhookKinds.installation_repositories; data: z.infer<typeof installationRepositoriesEventSchema> }
  | { kind: typeof WebhookKinds.pull_request; data: z.infer<typeof pullRequestEventSchema> }
  | { kind: typeof WebhookKinds.issues; data: z.infer<typeof issuesEventSchema> }
  | { kind: typeof WebhookKinds.ignored; eventType: string };
