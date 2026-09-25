import { inArray, max, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

const { discordRateLimits } = schema;

/** Data access for mocco_discord_rate_limits: shared Discord pacing, platform-scoped
 * (every workspace posts through the same bot). */
export class DiscordRateLimitRepo {
  constructor(private readonly db: Db) {}

  /** The latest `blocked_until` among `buckets` that is still in the future, if any. */
  async blockedUntil(buckets: readonly string[], now: Date): Promise<Date | undefined> {
    const [row] = await this.db
      .select({ until: max(discordRateLimits.blockedUntil) })
      .from(discordRateLimits)
      .where(inArray(discordRateLimits.bucket, [...buckets]));
    const until = row?.until ?? null;
    return until !== null && until.getTime() > now.getTime() ? until : undefined;
  }

  /** Block `bucket` until `until`. An existing, later block wins (concurrent runners). */
  async block(bucket: string, until: Date): Promise<void> {
    await this.db
      .insert(discordRateLimits)
      .values({ bucket, blockedUntil: until })
      .onConflictDoUpdate({
        target: discordRateLimits.bucket,
        set: { blockedUntil: sql`greatest(${discordRateLimits.blockedUntil}, excluded.blocked_until)` },
      });
  }
}
