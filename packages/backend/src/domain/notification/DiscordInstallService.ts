import { randomBytes } from 'node:crypto';

import { DiscordConnectStateInvalidError, DiscordInstallFailedError } from '@backend/domain/notification/errors';
import { DiscordOAuthResultKinds, type DiscordOAuth } from '@backend/domain/notification/senders/discord-oauth';

import type { DiscordConnectStateRepo } from '@backend/domain/notification/repos/discord-connect-state.repo';
import type { DiscordGuildRepo } from '@backend/domain/notification/repos/discord-guild.repo';

/** How long an install `state` stays valid (same as the GitHub connect flow). */
export const DISCORD_CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

const STATE_BYTES = 32;

export interface DiscordInstallServiceDeps {
  states: DiscordConnectStateRepo;
  guilds: DiscordGuildRepo;
  oauth: DiscordOAuth;
  now: () => Date;
}

/**
 * The Mocco bot install (relay design §6): a single-use state bound to the user and
 * workspace, Discord's OAuth2 authorize redirect, and the callback that consumes the
 * state, exchanges the code and records the guild the token response names.
 */
export class DiscordInstallService {
  constructor(private readonly deps: DiscordInstallServiceDeps) {}

  /** Issue a state for `userId` in `workspaceId` (the caller proved membership) and
   * return Discord's authorize URL. */
  async startInstall(userId: string, workspaceId: string): Promise<{ authorizeUrl: string }> {
    // Buffer is the base64 codec available without V8's --js-base-64 flag (see secret-box.ts).
    // eslint-disable-next-line unicorn/prefer-uint8array-base64
    const state = randomBytes(STATE_BYTES).toString('base64url');
    const expiresAt = new Date(this.deps.now().getTime() + DISCORD_CONNECT_STATE_TTL_MS);
    await this.deps.states.insert({ state, userId, workspaceId, expiresAt });
    return { authorizeUrl: this.deps.oauth.authorizeUrl(state) };
  }

  /**
   * Finish an install: consume `state` for `userId` (atomically — a second callback with
   * the same state fails), exchange `code`, and upsert the guild from the exchange
   * response. The callback's `guild_id` query parameter is never trusted. Explicitly
   * projected: the ext route has no `.output()` to strip the row.
   */
  async completeInstall(
    state: string,
    code: string,
    userId: string,
  ): Promise<{ workspaceId: string; guild: { id: string; guildId: string; guildName: string } }> {
    const consumed = await this.deps.states.consume(state, userId, this.deps.now());
    if (consumed === undefined) {
      throw new DiscordConnectStateInvalidError();
    }
    const { workspaceId } = consumed;
    const result = await this.deps.oauth.exchangeCode(code);
    if (result.kind === DiscordOAuthResultKinds.failed) {
      throw new DiscordInstallFailedError(workspaceId, result.reason);
    }
    const guild = await this.deps.guilds.upsert({
      workspaceId,
      guildId: result.guildId,
      guildName: result.guildName,
      installedByUserId: userId,
    });
    return { workspaceId, guild: { id: guild.id, guildId: guild.guildId, guildName: guild.guildName } };
  }
}
