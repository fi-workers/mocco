import { z } from 'zod';

/** External services that deliver webhooks to a workspace's inbound source. */
export const InboundKinds = {
  sentry: 'sentry',
  vercel: 'vercel',
  github: 'github',
} as const;
export type InboundKind = (typeof InboundKinds)[keyof typeof InboundKinds];
export const inboundKindSchema = z.enum(Object.values(InboundKinds) as [InboundKind, ...InboundKind[]]);

/**
 * Domain event types produced from inbound webhooks. Keys equal their values
 * (the dotted names are the event catalog's external contract), so call sites
 * read `InboundEventTypes['github.push']`.
 */
export const InboundEventTypes = {
  'sentry.issue.created': 'sentry.issue.created',
  'vercel.deployment.created': 'vercel.deployment.created',
  'vercel.deployment.succeeded': 'vercel.deployment.succeeded',
  'vercel.deployment.error': 'vercel.deployment.error',
  'vercel.deployment.canceled': 'vercel.deployment.canceled',
  'github.push': 'github.push',
  'github.pull_request.opened': 'github.pull_request.opened',
  'github.pull_request.reopened': 'github.pull_request.reopened',
  'github.pull_request.merged': 'github.pull_request.merged',
  'github.pull_request.closed': 'github.pull_request.closed',
  'github.issues.opened': 'github.issues.opened',
  'github.issues.reopened': 'github.issues.reopened',
  'github.issues.closed': 'github.issues.closed',
  'github.release.published': 'github.release.published',
  'github.workflow_run.failed': 'github.workflow_run.failed',
  'github.workflow_run.succeeded': 'github.workflow_run.succeeded',
} as const;
export type InboundEventType = (typeof InboundEventTypes)[keyof typeof InboundEventTypes];
export const inboundEventTypeSchema = z.enum(
  Object.values(InboundEventTypes) as [InboundEventType, ...InboundEventType[]],
);

/**
 * Flat, filterable attributes of an event. Notification rules match them by
 * equality (`{ target: 'production' }`), so values stay scalar.
 */
export const factsSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));
export type Facts = z.infer<typeof factsSchema>;
