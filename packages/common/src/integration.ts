import { z } from 'zod';

/**
 * Provider identities. GitHub is the only one today; the set is modeled as an
 * `as const` object + derived union (constants over enums) so a second provider
 * (GitLab/Bitbucket) is an additive change here.
 */
export const Providers = { github: 'github' } as const;
export type Provider = (typeof Providers)[keyof typeof Providers];
export const providerSchema = z.enum(Object.values(Providers) as [Provider, ...Provider[]]);

/** A workspace's connection to a provider account (e.g. a GitHub App installation). */
export const connectionSchema = z.object({
  id: z.uuid(),
  provider: providerSchema,
  accountLogin: z.string(),
});
export type ConnectionDto = z.infer<typeof connectionSchema>;

/** A repository registered under a connection. `externalRepoId` is the identity; owner/name are display-only. */
export const repoSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  externalRepoId: z.string(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  watchedBranch: z.string().nullable(),
});
export type RepoDto = z.infer<typeof repoSchema>;

/** A repo the provider can access but that isn't registered yet — the "add repository" picker. */
export const availableRepoSchema = z.object({
  externalRepoId: z.string(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
});
export type AvailableRepoDto = z.infer<typeof availableRepoSchema>;

export const repoAddInputSchema = z.object({
  connectionId: z.uuid(),
  externalRepoId: z.string(),
  watchedBranch: z.string().min(1).nullable().default(null),
});
export type RepoAddInput = z.infer<typeof repoAddInputSchema>;

export const watchedBranchInputSchema = z.object({
  repoId: z.uuid(),
  watchedBranch: z.string().min(1).nullable(),
});
export type WatchedBranchInput = z.infer<typeof watchedBranchInputSchema>;

/**
 * A synced commit from the watched branch's candidate queue. `seq` is the
 * opaque cursor and monotonic sort key — it's a DB `bigserial`, which exceeds
 * JS's safe-integer range over time, so it stays a string end-to-end.
 */
export const commitSchema = z.object({
  id: z.uuid(),
  repoId: z.uuid(),
  seq: z.string(),
  sha: z.string(),
  branch: z.string(),
  message: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  committedAt: z.date(),
});
export type CommitDto = z.infer<typeof commitSchema>;

export const commitsQueryInputSchema = z.object({
  workspaceId: z.uuid(),
  repoId: z.uuid(),
  cursor: z.string().regex(/^\d+$/).nullable().default(null),
  limit: z.number().int().min(1).max(50).default(20),
});
export type CommitsQueryInput = z.infer<typeof commitsQueryInputSchema>;

export const commitsPageSchema = z.object({
  commits: z.array(commitSchema),
  nextCursor: z.string().nullable(),
});
export type CommitsPageDto = z.infer<typeof commitsPageSchema>;
