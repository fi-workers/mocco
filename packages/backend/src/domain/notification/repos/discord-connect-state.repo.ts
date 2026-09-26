import { and, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

const { discordConnectStates } = schema;

/** Data access for mocco_discord_connect_states (the bot install handshake). */
export class DiscordConnectStateRepo {
  constructor(private readonly db: Db) {}

  async insert(values: { state: string; userId: string; workspaceId: string; expiresAt: Date }): Promise<void> {
    await this.db.insert(discordConnectStates).values(values);
  }

  /** Delete states that expired before `now` or were consumed (daily prune). Returns the count. */
  async prune(now: Date): Promise<number> {
    const deleted = await this.db
      .delete(discordConnectStates)
      .where(or(lt(discordConnectStates.expiresAt, now), isNotNull(discordConnectStates.consumedAt)))
      .returning({ state: discordConnectStates.state });
    return deleted.length;
  }

  /** Atomically consume a state for the user: set `consumed_at` where it is unconsumed,
   * unexpired and the user's. Returns the consumed row, or undefined when none matches
   * (unknown, already consumed, expired, or another user's). */
  async consume(state: string, userId: string, now: Date) {
    const [row] = await this.db
      .update(discordConnectStates)
      .set({ consumedAt: now })
      .where(
        and(
          eq(discordConnectStates.state, state),
          eq(discordConnectStates.userId, userId),
          isNull(discordConnectStates.consumedAt),
          gt(discordConnectStates.expiresAt, now),
        ),
      )
      .returning();
    return row;
  }
}
