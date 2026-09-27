// What a customer should do about a Discord failure reason. Reasons come from the
// backend's Discord client as `Discord <status> (code <json code>): <message>`; the codes
// are Discord's documented JSON error codes.

const HINTS: readonly { code: number; hint: string }[] = [
  {
    code: 50_001,
    hint: 'The bot cannot see this channel. In Discord, open the channel settings → Permissions, add the Mocco bot (or its role) and allow View Channel, then re-enable the channel.',
  },
  {
    code: 50_013,
    hint: 'The bot can see the channel but is missing a permission. Allow View Channel, Send Messages, Embed Links and Read Message History for the Mocco bot in this channel, then re-enable it.',
  },
  {
    code: 10_003,
    hint: 'The channel no longer exists in Discord. Delete it here and add another channel.',
  },
  {
    code: 10_004,
    hint: 'The Mocco bot is no longer in this Discord server. Connect Discord again, then add the channel again.',
  },
];

/** A one-sentence fix for a Discord failure reason, or undefined when there is no specific one. */
export function discordFixHint(reason: string | null): string | undefined {
  return HINTS.find(({ code }) => reason?.includes(`(code ${code})`) === true)?.hint;
}
