import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_github_connect_states (the install handshake). */
export class ConnectStateRepo {
  constructor(private readonly db: Db) {}

  async insert(values: { state: string; userId: string; workspaceId: string; expiresAt: Date }) {
    await this.db.insert(schema.githubConnectStates).values(values);
  }

  /** Atomically consume a state for the user: set consumedAt where it is unconsumed,
   * unexpired, and owned by the user. Returns the consumed row, or undefined when zero
   * rows match (unknown / already-consumed / expired / foreign) — the service decides
   * that means the state is invalid, and narrows the row to what it needs. */
  async consume(state: string, userId: string, now: Date) {
    const [row] = await this.db
      .update(schema.githubConnectStates)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.githubConnectStates.state, state),
          eq(schema.githubConnectStates.userId, userId),
          isNull(schema.githubConnectStates.consumedAt),
          gt(schema.githubConnectStates.expiresAt, now),
        ),
      )
      .returning();
    return row;
  }

  /** Atomically consume the newest unconsumed, unexpired state for a GitHub user id —
   * the reconciliation path for the `installation` webhook, which carries the installing
   * user's github id (sender) but no `state`. The github id is stamped on the state by the
   * setup-callback redirect (ownership verification); the async webhook claims it here.
   * Returns the consumed row, or undefined when none match (no pending handshake for that user). */
  async consumeByGithubUserId(githubUserId: string, now: Date) {
    const candidate = this.db
      .select({ state: schema.githubConnectStates.state })
      .from(schema.githubConnectStates)
      .where(
        and(
          eq(schema.githubConnectStates.githubUserId, githubUserId),
          isNull(schema.githubConnectStates.consumedAt),
          gt(schema.githubConnectStates.expiresAt, now),
        ),
      )
      .orderBy(desc(schema.githubConnectStates.createdAt))
      .limit(1);
    const [row] = await this.db
      .update(schema.githubConnectStates)
      .set({ consumedAt: now })
      .where(inArray(schema.githubConnectStates.state, candidate))
      .returning();
    return row;
  }
}
