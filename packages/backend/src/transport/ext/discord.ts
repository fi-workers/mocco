// The Discord bot install routes (notification relay design §6), mounted on the ext app
// under /api/ext. Browser redirects: a signed-in member starts the install, Discord
// sends them back to the callback. Thin adapters over DiscordInstallService.
import { Hono } from 'hono';
import { z } from 'zod';

import { NotFoundError } from '@backend/domain/errors';
import { DiscordConnectStateInvalidError, DiscordInstallFailedError } from '@backend/domain/notification/errors';

import type { AuthService } from '@backend/domain/auth/AuthService';
import type { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import type { DiscordInstallService } from '@backend/domain/notification/DiscordInstallService';

export const DISCORD_INSTALL_PATH = '/discord/install';

export interface DiscordInstallDeps {
  install: DiscordInstallService;
  workspace: Pick<WorkspaceService, 'assertMember'>;
}

const WORKSPACES = '/workspaces';
const SIGN_IN = '/auth/sign-in';
const CONNECT_ERROR = 'connect_error=1';

/** Where a finished Discord install lands: the workspace's notification channels tab. */
export const notificationChannelsPath = (workspaceId: string) =>
  `${WORKSPACES}/${workspaceId}/notifications?tab=channels`;

/** `discord` undefined (Discord env absent) → both routes 503. */
export function createDiscordInstallRoutes({
  auth,
  discord,
}: {
  auth: Pick<AuthService, 'getSession'>;
  discord: DiscordInstallDeps | undefined;
}): Hono {
  const routes = new Hono();

  // Discord bot install, step 1 (relay design §6). A signed-in member of `workspaceId`
  // gets a single-use state bound to them and the workspace, then goes to Discord.
  routes.get(DISCORD_INSTALL_PATH, async c => {
    if (!discord) {
      return c.text('Discord is not configured', 503);
    }
    const session = await auth.getSession(c.req.raw.headers);
    if (!session) {
      return c.redirect(SIGN_IN);
    }
    const workspaceId = z.uuid().safeParse(c.req.query('workspaceId'));
    if (!workspaceId.success) {
      return c.text('invalid workspace', 400);
    }
    try {
      await discord.workspace.assertMember(c.req.raw.headers, workspaceId.data);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.text('workspace not found', 404);
      }
      throw error;
    }
    const { authorizeUrl } = await discord.install.startInstall(session.user.id, workspaceId.data);
    return c.redirect(authorizeUrl);
  });

  // Discord bot install, step 2: Discord redirects back with `code` and `state` (and a
  // `guild_id` hint, never read: the guild comes from the code exchange).
  routes.get('/discord/callback', async c => {
    if (!discord) {
      return c.text('Discord is not configured', 503);
    }
    const session = await auth.getSession(c.req.raw.headers);
    if (!session) {
      return c.redirect(SIGN_IN);
    }
    const code = c.req.query('code');
    const state = c.req.query('state') ?? '';
    // No code: the user cancelled on Discord (`error=access_denied`). The state expires.
    if (code === undefined || code === '') {
      return c.redirect(`${WORKSPACES}?${CONNECT_ERROR}`);
    }
    try {
      const { workspaceId } = await discord.install.completeInstall(state, code, session.user.id);
      return c.redirect(notificationChannelsPath(workspaceId));
    } catch (error) {
      if (error instanceof DiscordConnectStateInvalidError) {
        return c.redirect(`${WORKSPACES}?${CONNECT_ERROR}`);
      }
      if (error instanceof DiscordInstallFailedError) {
        console.error('[discord] install exchange failed', error.message);
        return c.redirect(`${notificationChannelsPath(error.workspaceId)}&${CONNECT_ERROR}`);
      }
      throw error;
    }
  });

  return routes;
}
