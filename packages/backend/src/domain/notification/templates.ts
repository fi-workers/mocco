// Event → NeutralMessage, pure (platform foundations §12 "per-event templates").
// Inbound events carry the message their adapter rendered at ingest (relay design
// §4); governance events are rendered here from their payloads, with a link into
// the app built from the injected origin (SERVICE_DOMAIN) and the payload's linkPath.
// Senders own presentation (colors, emoji); templates only pick the severity.
import { DomainEventTypes } from '@mocco/common/events';
import { NeutralMessageLimits, neutralMessageSchema, Severities } from '@mocco/common/notification';
import { z } from 'zod';

import { truncate } from '@backend/domain/notification/senders/discord';

import type { DeliveredEvent } from '@backend/domain/events/EventBus';
import type { DomainEventPayload } from '@mocco/common/events';
import type { NeutralMessage, NeutralMessageField, Severity } from '@mocco/common/notification';

export interface TemplateContext {
  /** The app's origin (`https://www.mocco.club`), joined with each payload's `linkPath`. */
  appOrigin: string;
}

/** The footer of every message Mocco renders about itself. */
export const MOCCO_FOOTER = 'Mocco';

const SHORT_SHA_LENGTH = 7;

/** What every inbound event payload carries (relay design §4); only the message is read here. */
const inboundMessagePayloadSchema = z.object({ message: neutralMessageSchema });

type RunPayload = DomainEventPayload<typeof DomainEventTypes.runSucceeded>;
type GatePayload = DomainEventPayload<typeof DomainEventTypes.gatePending>;

function field(name: string, value: string, isInline = true): NeutralMessageField {
  return {
    name: truncate(name, NeutralMessageLimits.fieldName),
    value: truncate(value === '' ? '-' : value, NeutralMessageLimits.fieldValue),
    inline: isInline,
  };
}

function runFields(payload: RunPayload): NeutralMessageField[] {
  return [
    field('Repository', payload.repoFullName),
    field('Pipeline', payload.pipelineName),
    field('Commit', payload.commitSha.slice(0, SHORT_SHA_LENGTH)),
    ...(payload.triggeredByName === null ? [] : [field('Triggered by', payload.triggeredByName)]),
  ];
}

function governanceMessage(
  context: TemplateContext,
  payload: RunPayload,
  parts: { title: string; severity: Severity; description?: string; fields: NeutralMessageField[] },
): NeutralMessage {
  return neutralMessageSchema.parse({
    title: truncate(parts.title, NeutralMessageLimits.title),
    url: `${context.appOrigin}${payload.linkPath}`,
    ...(parts.description !== undefined && {
      description: truncate(parts.description, NeutralMessageLimits.description),
    }),
    severity: parts.severity,
    fields: parts.fields.slice(0, NeutralMessageLimits.fields),
    footer: MOCCO_FOOTER,
  });
}

function gateTitle(prefix: string, payload: Pick<GatePayload, 'pipelineName' | 'gateName'>): string {
  return `${prefix}: ${payload.pipelineName} · ${payload.gateName}`;
}

/** `2 × deployer, 1 × sre`. */
function describeRoleCounts(counts: readonly { role: string; count: number }[]): string {
  return counts.map(({ role, count }) => `${count} × ${role}`).join(', ');
}

/** The votes that resumed a gate, counted per role. */
function countByRole(votes: readonly { role: string }[]): { role: string; count: number }[] {
  const counts = votes.reduce(
    (byRole, { role }) => byRole.set(role, (byRole.get(role) ?? 0) + 1),
    new Map<string, number>(),
  );
  return [...counts].map(([role, count]) => ({ role, count }));
}

/** An absolute http(s) URL, or undefined (a logs link is only shown when it is one). */
function httpUrl(value: string | null): string | undefined {
  if (value === null || !URL.canParse(value)) {
    return undefined;
  }
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:' ? value : undefined;
}

function runFailedMessage(
  context: TemplateContext,
  payload: DomainEventPayload<typeof DomainEventTypes.runFailed>,
): NeutralMessage {
  const logsUrl = httpUrl(payload.logsUrl);
  const step = payload.failedStep;
  return governanceMessage(context, payload, {
    title: `Run failed: ${payload.pipelineName}`,
    severity: Severities.error,
    ...(step !== null && { description: `Step ${step.index + 1} "${step.name}" failed.` }),
    fields: [...runFields(payload), ...(logsUrl === undefined ? [] : [field('Logs', logsUrl, false)])],
  });
}

/**
 * The message for `event`. Throws when the result does not fit a NeutralMessage,
 * which would be a template bug (every governance input is bounded or truncated
 * here) or an inbound payload without a message.
 */
export function renderEventMessage(event: DeliveredEvent, context: TemplateContext): NeutralMessage {
  switch (event.type) {
    case DomainEventTypes.gatePending: {
      const { payload } = event;
      const needs = describeRoleCounts(payload.requirements);
      return governanceMessage(context, payload, {
        title: gateTitle('Approval needed', payload),
        severity: Severities.warning,
        description: `${payload.repoFullName} is waiting at gate "${payload.gateName}".`,
        fields: [
          ...runFields(payload),
          field('Gate', payload.gateName),
          ...(needs === '' ? [] : [field('Needs', needs)]),
        ],
      });
    }
    case DomainEventTypes.gateResumed: {
      const { payload } = event;
      return governanceMessage(context, payload, {
        title: gateTitle('Gate resumed', payload),
        severity: Severities.success,
        fields: [
          ...runFields(payload),
          field('Gate', payload.gateName),
          field('Resumed by', describeRoleCounts(countByRole(payload.resumedBy))),
        ],
      });
    }
    case DomainEventTypes.gateRejected: {
      const { payload } = event;
      return governanceMessage(context, payload, {
        title: gateTitle('Gate rejected', payload),
        severity: Severities.error,
        description: payload.reason === null || payload.reason === '' ? 'No reason given.' : payload.reason,
        fields: [...runFields(payload), field('Gate', payload.gateName)],
      });
    }
    case DomainEventTypes.runSucceeded: {
      return governanceMessage(context, event.payload, {
        title: `Run succeeded: ${event.payload.pipelineName}`,
        severity: Severities.success,
        fields: runFields(event.payload),
      });
    }
    case DomainEventTypes.runFailed: {
      return runFailedMessage(context, event.payload);
    }
    default: {
      // Inbound events (`sentry.*`, `vercel.*`, `github.*`): the adapter rendered the
      // message at ingest. Parsed here as well, so this function never trusts a caller.
      const inbound: { payload: unknown } = event;
      return inboundMessagePayloadSchema.parse(inbound.payload).message;
    }
  }
}
