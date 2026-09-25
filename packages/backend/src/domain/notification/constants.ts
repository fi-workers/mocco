// Notification domain constants (platform foundations §12, relay design §6–§8).

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** The notification domain's job kinds. */
export const NotificationJobKinds = {
  deliver: 'notification.deliver',
} as const;

/**
 * The fan-out's event bus subscribers, one per event family it listens to. The names
 * are permanent (they are part of the events.deliver dedupe key and ledger).
 */
export const NotificationSubscribers = {
  gate: { pattern: 'gate.*', name: 'notification.fan-out.gate' },
  run: { pattern: 'run.*', name: 'notification.fan-out.run' },
  sentry: { pattern: 'sentry.*', name: 'notification.fan-out.sentry' },
  vercel: { pattern: 'vercel.*', name: 'notification.fan-out.vercel' },
  github: { pattern: 'github.*', name: 'notification.fan-out.github' },
} as const;

export const DeliveryPolicy = {
  /** `max_attempts` of a `notification.deliver` job: about two hours of backoff (relay design §6). */
  maxAttempts: 8,
  /** Relay design §6: at most this many sends per workspace per minute; the rest wait. */
  workspacePerMinute: 120,
  /** The window the per-workspace limit counts sends in. */
  fairnessWindowMs: MINUTE,
  /** The shortest wait of a delivery over the workspace limit (it otherwise waits for
   * the oldest send in the window to age out). */
  fairnessMinRetryMs: SECOND,
  /** How long every send pauses after Discord rejects the bot itself (401, a Cloudflare block). */
  senderPauseMs: HOUR,
  /** How long a delivery waits when this deployment has no Discord bot token. */
  notConfiguredRetryMs: HOUR,
} as const;

/** Reasons stored on a delivery that did not come from Discord. */
export const DeliveryReasons = {
  channelDeleted: 'channel deleted',
  channelDisabled: (reason: string | null) => `channel disabled: ${reason ?? 'no reason recorded'}`,
  notConfigured: 'discord not configured',
  rateLimited: 'discord rate limit',
  workspaceLimit: 'workspace send limit (per minute) reached',
  senderPaused: 'discord sender paused (bot token or egress rejected)',
} as const;
