import { and, asc, eq, sql } from 'drizzle-orm';

import { AdvisoryLockNamespaces } from '@backend/infra/db/advisory-locks';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type InboxMemberRow = typeof schema.messengerInboxMembers.$inferSelect;

const im = schema.messengerInboxMembers;
const scoped = (workspaceId: string, projectId: string) =>
  and(eq(im.workspaceId, workspaceId), eq(im.projectId, projectId));
/** Someone who left the workspace keeps their row but is never listed or assigned. */
const stillInWorkspace = and(eq(schema.members.organizationId, im.workspaceId), eq(schema.members.userId, im.userId));

/** Data access for mocco_messenger_inbox_members. Scoped by workspace and project. */
export class MessengerInboxMemberRepo {
  constructor(private readonly db: Db) {}

  /** The project's inbox members who still belong to the workspace, oldest member first. */
  async list(workspaceId: string, projectId: string) {
    return await this.db
      .select({
        userId: im.userId,
        name: schema.users.name,
        email: schema.users.email,
        available: im.available,
        lastAssignedAt: im.lastAssignedAt,
      })
      .from(im)
      .innerJoin(schema.members, stillInWorkspace)
      .innerJoin(schema.users, eq(schema.users.id, im.userId))
      .where(scoped(workspaceId, projectId))
      .orderBy(asc(im.createdAt), asc(im.userId));
  }

  /** Whether the person belongs to the workspace (only its members can join an inbox). */
  async isWorkspaceMember(workspaceId: string, userId: string) {
    const rows = await this.db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.organizationId, workspaceId), eq(schema.members.userId, userId)));
    return rows.length > 0;
  }

  /** Add a member (available). Undefined when they already are one. */
  async add(row: { workspaceId: string; projectId: string; userId: string; createdAt: Date }) {
    const [inserted] = await this.db.insert(im).values(row).onConflictDoNothing().returning();
    return inserted;
  }

  /** Remove a member; undefined when they weren't one. */
  async remove(workspaceId: string, projectId: string, userId: string) {
    const [removed] = await this.db
      .delete(im)
      .where(and(scoped(workspaceId, projectId), eq(im.userId, userId)))
      .returning();
    return removed;
  }

  /** Turn a member's availability on or off; undefined when they aren't a member. */
  async setAvailable(workspaceId: string, projectId: string, userId: string, isAvailable: boolean) {
    const [updated] = await this.db
      .update(im)
      .set({ available: isAvailable })
      .where(and(scoped(workspaceId, projectId), eq(im.userId, userId)))
      .returning();
    return updated;
  }

  /**
   * Round robin: take the project's assignment lock for the rest of the transaction,
   * pick the available member (still in the workspace) whose last turn is the oldest,
   * and give them the project's next turn. Returns their user id, or undefined when no
   * one is available. Call inside a transaction only: the lock is what makes two new
   * conversations at once take two different turns, in order.
   */
  async takeTurn(workspaceId: string, projectId: string, now: Date): Promise<string | undefined> {
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(${AdvisoryLockNamespaces.messengerAssign}, hashtext(${projectId}))`,
    );
    const [next] = await this.db
      .select({ userId: im.userId })
      .from(im)
      .innerJoin(schema.members, stillInWorkspace)
      .where(and(scoped(workspaceId, projectId), eq(im.available, true)))
      .orderBy(asc(im.lastTurn), asc(im.createdAt), asc(im.userId))
      .limit(1);
    if (next === undefined) {
      return undefined;
    }
    // Safe to read then write: the lock keeps every other assignment in the project out.
    const [latest] = await this.db
      .select({ turn: sql<number>`coalesce(max(${im.lastTurn}), 0)::int` })
      .from(im)
      .where(scoped(workspaceId, projectId));
    await this.db
      .update(im)
      .set({ lastTurn: (latest?.turn ?? 0) + 1, lastAssignedAt: now })
      .where(and(scoped(workspaceId, projectId), eq(im.userId, next.userId)));
    return next.userId;
  }
}
