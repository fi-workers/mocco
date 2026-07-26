import type { AvailableRepoDto } from '@mocco/common/integration';

// Provider-agnostic ports (ISP: one per consumer). NO vendor imports here — the
// GitHub adapter (domain/integration/github/provider.ts) implements them and
// returns neutral @mocco/common types. Auth (token minting) lives inside the
// adapter, never on these ports.

/** Lists the repos a connection's account can access. Consumed by ConnectionService. */
export interface RepoLister {
  /** `externalAccountId` = github installation id. */
  listRepos(externalAccountId: string): Promise<AvailableRepoDto[]>;
}

export interface OwnershipResult {
  ownerVerified: boolean;
  accountLogin: string;
  githubUserId: string;
}

/** Install-handshake operations. Consumed by ConnectionService (installUrl) and the setup route (verifyOwnership). */
export interface InstallationVerifier {
  /** Exchange the setup-callback OAuth `code` for a user token and confirm the caller admins `externalAccountId`. */
  verifyOwnership(code: string, externalAccountId: string): Promise<OwnershipResult>;
  /** Build the provider install URL carrying our opaque `state`. */
  installUrl(state: string): string;
}

export interface SourceCommit {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedAt: Date;
}

/** Backfill/read-back of commit history. Consumed by the commit-sync service. */
export interface CommitSource {
  /** Recent commits on a branch (bounded backfill). `limit` capped by the caller at BACKFILL_MAX_LIMIT. */
  listCommits(
    ref: { externalAccountId: string; owner: string; name: string },
    branch: string,
    limit: number,
  ): Promise<SourceCommit[]>;
  /** Raw `.mocco.yml` at a commit SHA, or null when the repo has none at that SHA (404). */
  getConfigAtCommit(
    ref: { externalAccountId: string; owner: string; name: string },
    sha: string,
  ): Promise<string | null>;
}
