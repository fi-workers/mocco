import { and, asc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

const { discordGuilds } = schema;

export type DiscordGuildRow = typeof discordGuilds.$inferSelect;

/** Data access for mocco_discord_guilds (ADR 0012). Every query is workspace-scoped. */
export class DiscordGuildRepo {
  constructor(private readonly db: Db) {}

  /** Record an install; installing into the same guild again refreshes its name, installer
   * and `installed_at`. */
  async upsert(values: {
    workspaceId: string;
    guildId: string;
    guildName: string;
    installedByUserId: string | null;
    installedAt: Date;
  }): Promise<DiscordGuildRow> {
    return expectOne(
      await this.db
        .insert(discordGuilds)
        .values(values)
        .onConflictDoUpdate({
          target: [discordGuilds.workspaceId, discordGuilds.guildId],
          set: {
            guildName: values.guildName,
            installedByUserId: values.installedByUserId,
            installedAt: values.installedAt,
          },
        })
        .returning(),
    );
  }

  async findByWorkspace(workspaceId: string): Promise<DiscordGuildRow[]> {
    return await this.db
      .select()
      .from(discordGuilds)
      .where(eq(discordGuilds.workspaceId, workspaceId))
      .orderBy(asc(discordGuilds.createdAt), asc(discordGuilds.id));
  }

  /** Forget an install (its channels cascade). Returns false when absent. */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(discordGuilds)
      .where(and(eq(discordGuilds.workspaceId, workspaceId), eq(discordGuilds.id, id)))
      .returning({ id: discordGuilds.id });
    return deleted.length > 0;
  }

  async findById(workspaceId: string, id: string): Promise<DiscordGuildRow | undefined> {
    const [row] = await this.db
      .select()
      .from(discordGuilds)
      .where(and(eq(discordGuilds.workspaceId, workspaceId), eq(discordGuilds.id, id)));
    return row;
  }
}
