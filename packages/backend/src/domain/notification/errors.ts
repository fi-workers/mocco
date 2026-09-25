// Notification-domain errors. Services throw these; the notification router maps the
// shared bases (NotFound → NOT_FOUND, Conflict → CONFLICT, BadRequest → BAD_REQUEST).
import { BadRequestError, ConflictError, NotFoundError } from '@backend/domain/errors';

/** A transient sender failure (5xx, timeout, network): thrown so the delivery job
 * retries with the queue's backoff. The message is the sender's redacted reason. */
export class TransientDeliveryError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'TransientDeliveryError';
  }
}

/** A channel that doesn't exist or isn't the workspace's. */
export class NotificationChannelNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Notification channel ${id} was not found`, options);
    this.name = 'NotificationChannelNotFoundError';
  }
}

/** A rule that doesn't exist or isn't the workspace's. */
export class NotificationRuleNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Notification rule ${id} was not found`, options);
    this.name = 'NotificationRuleNotFoundError';
  }
}

/** A Discord server the workspace hasn't installed the bot into. */
export class DiscordGuildNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) {
    super(`Discord server ${id} was not found`, options);
    this.name = 'DiscordGuildNotFoundError';
  }
}

/**
 * The bot is no longer in the guild as this workspace installed it (it left, or was
 * re-added later, possibly through another workspace). The stale install was removed;
 * connect Discord again.
 */
export class DiscordReinstallRequiredError extends BadRequestError {
  constructor(guildName: string, options?: ErrorOptions) {
    super(`The Mocco bot is no longer installed in ${guildName} for this workspace; connect Discord again`, options);
    this.name = 'DiscordReinstallRequiredError';
  }
}

/** The Discord channel is not a text channel of that server (or the bot can't see it). */
export class DiscordChannelNotInGuildError extends NotFoundError {
  constructor(channelId: string, options?: ErrorOptions) {
    super(`Discord channel ${channelId} is not a text channel of that server`, options);
    this.name = 'DiscordChannelNotInGuildError';
  }
}

/** The workspace already has a notification channel for that Discord channel. */
export class NotificationChannelExistsError extends ConflictError {
  constructor(channelId: string, options?: ErrorOptions) {
    super(`Discord channel ${channelId} is already a notification channel`, options);
    this.name = 'NotificationChannelExistsError';
  }
}

/** The channel already has the same rule (type, source and filter). */
export class NotificationRuleExistsError extends ConflictError {
  constructor(eventType: string, options?: ErrorOptions) {
    super(`The channel already has a rule for ${eventType} with that filter`, options);
    this.name = 'NotificationRuleExistsError';
  }
}

/** A rule names an exact event type that no source or domain publishes. */
export class UnknownRuleEventTypeError extends BadRequestError {
  constructor(eventType: string, options?: ErrorOptions) {
    super(`Unknown event type ${eventType}`, options);
    this.name = 'UnknownRuleEventTypeError';
  }
}

/** This deployment has no Discord bot token, so nothing can be asked of Discord. */
export class DiscordNotConfiguredError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('Discord is not configured on this deployment', options);
    this.name = 'DiscordNotConfiguredError';
  }
}

/** Discord refused or failed a request made for the user (the reason is Discord's, redacted). */
export class DiscordRequestFailedError extends BadRequestError {
  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'DiscordRequestFailedError';
  }
}

/** The install `state` is unknown, consumed, expired or another user's. */
export class DiscordConnectStateInvalidError extends Error {
  constructor(options?: ErrorOptions) {
    super('Discord connect state is invalid or expired', options);
    this.name = 'DiscordConnectStateInvalidError';
  }
}

/** The OAuth code exchange failed; the user may try the install again. */
export class DiscordInstallFailedError extends Error {
  constructor(
    readonly workspaceId: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(reason, options);
    this.name = 'DiscordInstallFailedError';
  }
}
