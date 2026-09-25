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
  parseJson,
  type ParsedInbound,
  singleLine,
  truncate,
  withHttps,
} from '@backend/domain/inbound/sources/shared';

import type { Facts, InboundEventType } from '@mocco/common/inbound';
import type { Severity } from '@mocco/common/notification';

// Vercel team webhooks (vercel.com/docs/webhooks/webhooks-api). Only the fields
// used are declared; zod ignores the rest.

const SIGNATURE_HEADER = 'x-vercel-signature';

// Vercel sends target "production", a custom environment name, or null for a
// preview deployment.
const PREVIEW_TARGET = 'preview';
const COMMIT_MESSAGE_MAX = 300;

interface DeploymentMapping {
  type: InboundEventType;
  label: string;
  severity: Severity;
}

const deploymentMappings: Record<string, DeploymentMapping> = {
  'deployment.created': {
    type: InboundEventTypes['vercel.deployment.created'],
    label: 'Started',
    severity: Severities.info,
  },
  'deployment.succeeded': {
    type: InboundEventTypes['vercel.deployment.succeeded'],
    label: 'Ready',
    severity: Severities.success,
  },
  'deployment.error': {
    type: InboundEventTypes['vercel.deployment.error'],
    label: 'Failed',
    severity: Severities.error,
  },
  'deployment.canceled': {
    type: InboundEventTypes['vercel.deployment.canceled'],
    label: 'Canceled',
    severity: Severities.info,
  },
};

const envelopeSchema = z.object({ id: z.string().optional(), type: z.string() });

// `githubCommitRef` / `githubCommitMessage` are Vercel's git metadata keys; the
// docs describe `deployment.meta` only as a map, so both stay optional.
const metaSchema = z
  .object({ githubCommitRef: z.string().optional(), githubCommitMessage: z.string().optional() })
  .optional();

const deploymentSchema = z.object({
  payload: z.object({
    name: z.string().optional(),
    target: z.string().nullish(),
    url: z.string().optional(),
    meta: metaSchema,
    deployment: z
      .object({
        name: z.string().optional(),
        url: z.string().optional(),
        target: z.string().nullish(),
        meta: metaSchema,
      })
      .optional(),
    project: z.object({ id: z.string() }).optional(),
    links: z.object({ deployment: z.string().optional() }).optional(),
  }),
});

/** `x-vercel-signature` is the bare hex HMAC-SHA1 of the raw body. */
// eslint-disable-next-line unicorn/consistent-boolean-name -- the adapter contract names it verify
export function verify(rawBody: string, headers: Headers, secret: string): boolean {
  const signature = headerValue(headers, SIGNATURE_HEADER);
  return signature !== undefined && isValidHmacHex(HmacAlgorithms.sha1, secret, rawBody, signature);
}

/** Vercel's delivery id is the payload's top-level `id`. */
export function deliveryId(rawBody: string, _headers: Headers): string | undefined {
  const envelope = z.object({ id: z.string().trim().min(1) }).safeParse(parseJson(rawBody));
  return envelope.success ? envelope.data.id : undefined;
}

export function parse(rawBody: string, _headers: Headers): ParsedInbound {
  const json = parseJson(rawBody);
  if (json === undefined) {
    return ignored(IgnoredReasons.malformedJson);
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    return ignored('vercel payload does not match the expected shape');
  }
  const mapping = deploymentMappings[envelope.data.type];
  if (mapping === undefined) {
    return ignored(`vercel event "${envelope.data.type}" is not mapped`);
  }
  const body = deploymentSchema.safeParse(json);
  if (!body.success) {
    return ignored('vercel deployment payload does not match the expected shape');
  }

  const { payload } = body.data;
  const { deployment } = payload;
  const project = payload.name ?? deployment?.name ?? payload.project?.id ?? 'project';
  const target = payload.target ?? deployment?.target ?? PREVIEW_TARGET;
  const meta = deployment?.meta ?? payload.meta;
  const branch = meta?.githubCommitRef;
  const commitMessage = meta?.githubCommitMessage;
  const rawUrl = deployment?.url ?? payload.url;

  const message = buildMessage({
    title: `${mapping.label} · ${project}`,
    url: rawUrl === undefined ? payload.links?.deployment : withHttps(rawUrl),
    description:
      commitMessage === undefined ? undefined : `> ${singleLine(truncate(commitMessage, COMMIT_MESSAGE_MAX))}`,
    severity: mapping.severity,
    fields: [
      { name: 'Environment', value: target, inline: true },
      { name: 'Branch', value: branch === undefined ? '' : `\`${branch}\``, inline: true },
    ],
    footer: `Vercel · ${project}`,
  });
  const facts: Facts = branch === undefined ? { project, target } : { project, target, branch };
  return mapped(mapping.type, facts, message);
}
