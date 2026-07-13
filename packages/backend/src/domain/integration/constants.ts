// Fixed sets as `as const` objects + derived unions (constants over enums).

export const ConnectionStatuses = { active: 'active', suspended: 'suspended', deleted: 'deleted' } as const;
export type ConnectionStatus = (typeof ConnectionStatuses)[keyof typeof ConnectionStatuses];

export const RepoStatuses = { active: 'active', inactive: 'inactive' } as const;
export type RepoStatus = (typeof RepoStatuses)[keyof typeof RepoStatuses];

/** Commits fetched on a fresh watch (slice 3b). Bounded — never an unbounded paginate. */
export const BACKFILL_DEFAULT_LIMIT = 30;
export const BACKFILL_MAX_LIMIT = 100;
