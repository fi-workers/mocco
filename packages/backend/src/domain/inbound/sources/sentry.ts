import { InboundEventTypes } from '@mocco/common/inbound';
import { Severities } from '@mocco/common/notification';
import { z } from 'zod';

import {
  buildMessage,
  headerValue,
  HmacAlgorithms,
  ignored,
  IgnoredReasons,
  isValidHmacHex,
  mapped,
  nonEmpty,
  ownValue,
  parseJson,
  type ParsedInbound,
  sanitize,
  sourceEventLabel,
  truncate,
} from '@backend/domain/inbound/sources/shared';

import type { Facts } from '@mocco/common/inbound';
import type { Severity } from '@mocco/common/notification';

// Sentry integration-platform webhooks (an internal integration subscribed to
// the "issue" resource). Only the fields used are declared; zod ignores the rest.

const SIGNATURE_HEADER = 'sentry-hook-signature';
const RESOURCE_HEADER = 'sentry-hook-resource';
const DELIVERY_HEADER = 'request-id';

const SentryResources = { issue: 'issue' } as const;
const SentryIssueActions = { created: 'created' } as const;

const UNKNOWN_ENVIRONMENT = 'unknown';
const DEFAULT_LEVEL = 'error';
// Leaves room for the surrounding backticks inside the field value limit.
const CULPRIT_MAX = 1000;

const envelopeSchema = z.object({ action: z.string() });

const issueSchema = z.object({
  data: z.object({
    issue: z.object({
      title: z.string().min(1),
      shortId: z.string().optional(),
      culprit: z.string().nullish(),
      level: z.string().nullish(),
      // Not part of Sentry's documented issue payload; read when present.
      environment: z.string().nullish(),
      web_url: z.string().nullish(),
      permalink: z.string().nullish(),
      project: z.object({ slug: z.string().optional(), name: z.string().optional() }).optional(),
    }),
  }),
});

const levelSeverities: Record<string, Severity> = {
  fatal: Severities.error,
  error: Severities.error,
  warning: Severities.warning,
  info: Severities.info,
  debug: Severities.info,
};

/** `Sentry-Hook-Signature` is the bare hex HMAC-SHA256 of the raw body. */
// eslint-disable-next-line unicorn/consistent-boolean-name -- the adapter contract names it verify
export function verify(rawBody: Uint8Array, headers: Headers, secret: string): boolean {
  const signature = headerValue(headers, SIGNATURE_HEADER);
  return signature !== undefined && isValidHmacHex(HmacAlgorithms.sha256, secret, rawBody, signature);
}

export function deliveryId(_rawBody: string, headers: Headers): string | undefined {
  return headerValue(headers, DELIVERY_HEADER);
}

/** `<resource>.<action>`, e.g. `issue.created`; undefined without the resource header. */
export function sourceEvent(rawBody: string, headers: Headers): string | undefined {
  const resource = headerValue(headers, RESOURCE_HEADER);
  return resource === undefined ? undefined : sourceEventLabel(resource, parseJson(rawBody));
}

export function parse(rawBody: string, headers: Headers): ParsedInbound {
  const resource = headerValue(headers, RESOURCE_HEADER);
  if (resource === undefined) {
    return ignored('missing Sentry-Hook-Resource header');
  }
  if (resource !== SentryResources.issue) {
    return ignored(`sentry resource "${resource}" is not mapped`);
  }
  const json = parseJson(rawBody);
  if (json === undefined) {
    return ignored(IgnoredReasons.malformedJson);
  }
  const envelope = envelopeSchema.safeParse(json);
  if (envelope.success && envelope.data.action !== SentryIssueActions.created) {
    return ignored(`sentry action "${envelope.data.action}" is not mapped`);
  }
  const body = issueSchema.safeParse(json);
  if (!envelope.success || !body.success) {
    return ignored('sentry issue payload does not match the expected shape');
  }

  const { issue } = body.data.data;
  const level = sanitize(nonEmpty(issue.level) ?? DEFAULT_LEVEL).toLowerCase();
  const environment = nonEmpty(issue.environment) ?? UNKNOWN_ENVIRONMENT;
  const project = nonEmpty(issue.project?.slug) ?? nonEmpty(issue.project?.name);
  const message = buildMessage({
    title: issue.title,
    url: nonEmpty(issue.web_url) ?? nonEmpty(issue.permalink),
    severity: ownValue(levelSeverities, level) ?? Severities.error,
    fields: [
      { name: 'Issue', value: issue.shortId ?? '', inline: true },
      { name: 'Level', value: level, inline: true },
      { name: 'Environment', value: environment, inline: true },
      { name: 'Culprit', value: issue.culprit ? `\`${truncate(issue.culprit, CULPRIT_MAX)}\`` : '' },
    ],
    footer: project === undefined ? 'Sentry' : `Sentry · ${project}`,
  });
  const facts: Facts = project === undefined ? { environment, level } : { project, environment, level };
  return mapped(InboundEventTypes['sentry.issue.created'], facts, message);
}
