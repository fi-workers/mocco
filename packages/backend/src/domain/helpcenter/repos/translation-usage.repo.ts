import { and, eq, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

const u = schema.helpTranslationUsage;

/** Data access for mocco_help_translation_usage: characters translated per workspace and month. */
export class HelpTranslationUsageRepo {
  constructor(private readonly db: Db) {}

  /**
   * Count `characters` against the month, unless that would pass `limit`. Atomic: two
   * runs reserving at once can't both slip under the limit. True when reserved.
   */
  async reserve(workspaceId: string, month: string, characters: number, limit?: number): Promise<boolean> {
    if (characters <= 0) {
      return true;
    }
    await this.db.insert(u).values({ workspaceId, month }).onConflictDoNothing();
    const fits = limit === undefined ? [] : [sql`${u.characters} + ${characters} <= ${limit}`];
    const updated = await this.db
      .update(u)
      .set({ characters: sql`${u.characters} + ${characters}`, updatedAt: new Date() })
      .where(and(eq(u.workspaceId, workspaceId), eq(u.month, month), ...fits))
      .returning({ characters: u.characters });
    return updated.length > 0;
  }

  /** Give back characters reserved for text that was never translated (an outage). */
  async refund(workspaceId: string, month: string, characters: number): Promise<void> {
    if (characters <= 0) {
      return;
    }
    await this.db
      .update(u)
      .set({ characters: sql`greatest(${u.characters} - ${characters}, 0)`, updatedAt: new Date() })
      .where(and(eq(u.workspaceId, workspaceId), eq(u.month, month)));
  }

  /** Characters counted in the month (0 when none). */
  async used(workspaceId: string, month: string): Promise<number> {
    const [row] = await this.db
      .select({ characters: u.characters })
      .from(u)
      .where(and(eq(u.workspaceId, workspaceId), eq(u.month, month)));
    return row?.characters ?? 0;
  }
}
