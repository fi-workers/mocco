import { z } from 'zod';

import { FlagEventTypes, GovernanceEventTypes, MessengerEventTypes, OtaEventTypes } from './events';
import { InboundEventTypes } from './inbound';

import type { RuleFilter } from './notification';

// The default rule sets live apart from ./notification because they name catalog
// types: ./events imports ./notification (the inbound payload carries a
// NeutralMessage), so ./notification importing ./events would be an import cycle.

/**
 * Default rule sets (relay design §7), applied to a channel in one action. Each
 * rule is an event type and a filter; the customer can remove or add rules after.
 */
export const RulePresets = {
  mocco: 'mocco',
  sentry: 'sentry',
  vercel: 'vercel',
  github: 'github',
} as const;
export type RulePreset = (typeof RulePresets)[keyof typeof RulePresets];
export const rulePresetSchema = z.enum(Object.values(RulePresets) as [RulePreset, ...RulePreset[]]);

export interface PresetRule {
  eventType: string;
  filter: RuleFilter;
}

export const rulePresetRules: Readonly<Record<RulePreset, readonly PresetRule[]>> = {
  [RulePresets.mocco]: [
    { eventType: GovernanceEventTypes.gatePending, filter: {} },
    { eventType: GovernanceEventTypes.gateResumed, filter: {} },
    { eventType: GovernanceEventTypes.gateRejected, filter: {} },
    { eventType: GovernanceEventTypes.runFailed, filter: {} },
    { eventType: OtaEventTypes.otaPromotionRequested, filter: {} },
    { eventType: OtaEventTypes.otaPromotionApproved, filter: {} },
    { eventType: OtaEventTypes.otaPromotionRejected, filter: {} },
    { eventType: OtaEventTypes.otaEmergencyLaunchSpike, filter: {} },
    { eventType: FlagEventTypes.flagChangesetRequested, filter: {} },
    { eventType: FlagEventTypes.flagChangesetApplied, filter: {} },
    { eventType: FlagEventTypes.flagChangesetRejected, filter: {} },
    { eventType: FlagEventTypes.flagKilled, filter: {} },
    { eventType: FlagEventTypes.flagStaleDigest, filter: {} },
    { eventType: MessengerEventTypes.messengerConversationCreated, filter: {} },
    { eventType: MessengerEventTypes.messengerMessageReceived, filter: {} },
  ],
  [RulePresets.sentry]: [{ eventType: InboundEventTypes['sentry.issue.created'], filter: {} }],
  [RulePresets.vercel]: [
    { eventType: InboundEventTypes['vercel.deployment.succeeded'], filter: { target: 'production' } },
    { eventType: InboundEventTypes['vercel.deployment.error'], filter: {} },
    { eventType: InboundEventTypes['vercel.deployment.canceled'], filter: {} },
  ],
  [RulePresets.github]: [
    { eventType: InboundEventTypes['github.push'], filter: { hasCommits: true } },
    { eventType: InboundEventTypes['github.pull_request.opened'], filter: {} },
    { eventType: InboundEventTypes['github.pull_request.reopened'], filter: {} },
    { eventType: InboundEventTypes['github.pull_request.merged'], filter: {} },
    { eventType: InboundEventTypes['github.pull_request.closed'], filter: {} },
    { eventType: InboundEventTypes['github.issues.opened'], filter: {} },
    { eventType: InboundEventTypes['github.issues.reopened'], filter: {} },
    { eventType: InboundEventTypes['github.issues.closed'], filter: {} },
    { eventType: InboundEventTypes['github.release.published'], filter: {} },
    { eventType: InboundEventTypes['github.workflow_run.failed'], filter: {} },
  ],
};
