import { SubscriberChannels } from '@mocco/common/status';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { SubscriberLocale } from '@mocco/common/status';

export type SubscriberRow = typeof schema.statusSubscribers.$inferSelect;

const s = schema.statusSubscribers;

/** Following the page: confirmed and not unsubscribed since. */
const isActive = and(isNotNull(s.confirmedAt), isNull(s.unsubscribedAt));

/** Data access for mocco_status_subscribers. The public routes reach a subscriber by the id in a
 * signed link, and the fan-out by its page, so reads are by id or page, never by caller scope. */
export class SubscriberRepo {
  constructor(private readonly db: Db) {}

  /**
   * Record an email sign-up as pending confirmation. A new address is inserted; an address that
   * never confirmed or has unsubscribed starts over with the new components and language. An
   * address already following the page is left as it is (a stranger can't change its choices),
   * and undefined is returned.
   */
  async upsertPendingEmail(row: {
    workspaceId: string;
    projectId: string;
    pageId: string;
    email: string;
    componentIds: string[] | null;
    locale: SubscriberLocale;
  }): Promise<SubscriberRow | undefined> {
    const [subscriber] = await this.db
      .insert(s)
      .values({ ...row, channel: SubscriberChannels.email })
      .onConflictDoUpdate({
        target: [s.pageId, s.email],
        set: {
          componentIds: row.componentIds,
          locale: row.locale,
          confirmedAt: null,
          unsubscribedAt: null,
          updatedAt: new Date(),
        },
        setWhere: or(isNull(s.confirmedAt), isNotNull(s.unsubscribedAt)),
      })
      .returning();
    return subscriber;
  }

  /** Take the right to send a confirmation now: only when none was queued since `before`. */
  async claimConfirmation(id: string, now: Date, before: Date): Promise<boolean> {
    const claimed = await this.db
      .update(s)
      .set({ confirmationSentAt: now })
      .where(and(eq(s.id, id), or(isNull(s.confirmationSentAt), lt(s.confirmationSentAt, before))))
      .returning({ id: s.id });
    return claimed.length > 0;
  }

  async findById(id: string): Promise<SubscriberRow | undefined> {
    const [row] = await this.db.select().from(s).where(eq(s.id, id));
    return row;
  }

  /** Confirm a subscriber that hasn't unsubscribed; the first confirmation's time is kept. */
  async confirm(id: string, now: Date): Promise<SubscriberRow | undefined> {
    const [row] = await this.db
      .update(s)
      .set({ confirmedAt: sql`coalesce(${s.confirmedAt}, ${now})` })
      .where(and(eq(s.id, id), isNull(s.unsubscribedAt)))
      .returning();
    return row;
  }

  /** Unsubscribe; unsubscribing again keeps the first time. */
  async unsubscribe(id: string, now: Date): Promise<SubscriberRow | undefined> {
    const [row] = await this.db
      .update(s)
      .set({ unsubscribedAt: sql`coalesce(${s.unsubscribedAt}, ${now})` })
      .where(eq(s.id, id))
      .returning();
    return row;
  }

  /** The page's email subscribers who confirmed and haven't unsubscribed. */
  async listActiveEmail(pageId: string): Promise<SubscriberRow[]> {
    return await this.db
      .select()
      .from(s)
      .where(and(eq(s.pageId, pageId), eq(s.channel, SubscriberChannels.email), isActive))
      .orderBy(s.createdAt, s.id);
  }

  /** Delete sign-ups never confirmed whose last confirmation went out before `before`. */
  async pruneUnconfirmed(before: Date): Promise<number> {
    const deleted = await this.db
      .delete(s)
      .where(and(isNull(s.confirmedAt), lt(sql`coalesce(${s.confirmationSentAt}, ${s.createdAt})`, before)))
      .returning({ id: s.id });
    return deleted.length;
  }
}
