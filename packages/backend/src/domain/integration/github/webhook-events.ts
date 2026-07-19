import { z } from 'zod';

// GitHub-namespaced webhook payload schemas. These are NOT neutral — they mirror
// GitHub App webhook taxonomy verbatim and live next to the GitHub adapter (never
// in @mocco/common). Only the fields we consume are declared; unknown fields pass
// through untouched (zod objects ignore extras by default). Parse with
// `safeParse` at the boundary.

const repoRef = z.object({ id: z.number(), name: z.string(), owner: z.object({ login: z.string() }) });

export const pushEventSchema = z.object({
  ref: z.string(), // refs/heads/<branch>
  installation: z.object({ id: z.number() }),
  repository: repoRef,
  commits: z.array(
    z.object({
      id: z.string(), // sha
      message: z.string(),
      timestamp: z.string(),
      author: z.object({ name: z.string(), email: z.string() }),
    }),
  ),
});

export const installationEventSchema = z.object({
  action: z.enum(['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted']),
  installation: z.object({ id: z.number(), account: z.object({ login: z.string(), id: z.number() }) }),
  sender: z.object({ login: z.string(), id: z.number() }),
});

export const installationRepositoriesEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
});

export type ParsedWebhook =
  | { kind: 'push'; data: z.infer<typeof pushEventSchema> }
  | { kind: 'installation'; data: z.infer<typeof installationEventSchema> }
  | { kind: 'installation_repositories'; data: z.infer<typeof installationRepositoriesEventSchema> }
  | { kind: 'ignored'; eventType: string };
