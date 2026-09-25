// The stage0 canary itself, pure (no I/O): its id, the signed synthetic GitHub delivery,
// the ingest URL it may be sent to (the SSRF guard), and how a canary event is told
// apart from every other event. docs/reference/ops-stage0.md.
import { createHmac } from 'node:crypto';

import { InboundEventTypes } from '@mocco/common/inbound';
import { z } from 'zod';

import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { INBOUND_INGEST_PATH, INGEST_KEY_PATTERN } from '@backend/domain/inbound/constants';
import { CanaryReasons, Stage0Canary } from '@backend/domain/ops/constants';

/**
 * `stage0-<ISO minute>` (`stage0-2026-09-25T10:05Z`): the canary's GitHub delivery id.
 * Minute precision on purpose: a canary job retried within the same minute resends the
 * same id, and the receipt dedupes it instead of posting twice.
 */
export function canaryIdAt(now: Date): string {
  return `${Stage0Canary.idPrefix}${now.toISOString().slice(0, 16)}Z`;
}

export interface CanaryRequest {
  /** The exact bytes signed and sent. */
  body: Uint8Array;
  headers: Headers;
}

/**
 * The synthetic delivery GitHub would send for a successful workflow run, signed like
 * GitHub signs (`X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body>`). The
 * canary id is the delivery id and the run's `head_branch`, so it reaches the event as
 * the `branch` fact and the message's Branch field.
 */
export function buildCanaryRequest(input: { canaryId: string; secret: string; appOrigin: string }): CanaryRequest {
  const payload = {
    action: Stage0Canary.action,
    workflow_run: {
      name: Stage0Canary.workflow,
      head_branch: input.canaryId,
      status: Stage0Canary.action,
      conclusion: Stage0Canary.conclusion,
      html_url: `${input.appOrigin}/`,
    },
    repository: { full_name: Stage0Canary.repo },
    sender: { login: Stage0Canary.sender },
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature = createHmac('sha256', input.secret).update(body).digest('hex');
  const headers = new Headers({
    'content-type': 'application/json',
    'user-agent': Stage0Canary.userAgent,
    'x-github-event': Stage0Canary.githubEvent,
    'x-github-delivery': input.canaryId,
    'x-hub-signature-256': `sha256=${signature}`,
  });
  return { body, headers };
}

export type CanaryUrl = { url: string } | { refused: string };

/**
 * The canary source's ingest URL on SERVICE_DOMAIN, or why it is refused. The SSRF
 * guard: the canary is only ever POSTed to this deployment's own public host. A
 * SERVICE_DOMAIN that is not a bare authority (`user@host`, a path, a default port) or
 * an ingest key that is not one we issue would move the request elsewhere, so the
 * built URL must have exactly that host and path.
 */
// eslint-disable-next-line sonarjs/function-return-type -- each branch is one member of the CanaryUrl union
export function canaryIngestUrl(serviceDomain: string | undefined, ingestKey: string): CanaryUrl {
  if (serviceDomain === undefined) {
    return { refused: CanaryReasons.noServiceDomain };
  }
  if (!INGEST_KEY_PATTERN.test(ingestKey)) {
    return { refused: CanaryReasons.malformedIngestKey };
  }
  const path = `${INBOUND_INGEST_PATH}/${ingestKey}`;
  const candidate = `${resolveBaseOrigin({ serviceDomain })}${path}`;
  if (!URL.canParse(candidate)) {
    return { refused: CanaryReasons.foreignHost };
  }
  const url = new URL(candidate);
  // sonarjs/null-dereference is a false positive: `serviceDomain` was narrowed to a string above.
  // eslint-disable-next-line sonarjs/null-dereference
  const host = serviceDomain.toLowerCase();
  const isOwnHost = url.host === host && url.username === '' && url.password === '' && url.pathname === path;
  return isOwnHost ? { url: url.href } : { refused: CanaryReasons.foreignHost };
}

const canaryPayloadSchema = z.object({
  sourceId: z.string(),
  facts: z.object({ workflow: z.unknown(), branch: z.unknown() }),
});

/**
 * Whether an event is the stage0 canary: a `github.workflow_run.succeeded` received by
 * the canary source for the canary workflow. The source id is what makes it
 * trustworthy: only Mocco signs for that source, so another workspace sending a run
 * named `mocco-stage0-canary` never deletes its message or pings the heartbeat.
 */
export function stage0CanaryMatcher(canarySourceId: string): (event: { type: string; payload: unknown }) => boolean {
  return event => {
    if (event.type !== InboundEventTypes['github.workflow_run.succeeded']) {
      return false;
    }
    const parsed = canaryPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      return false;
    }
    const { sourceId, facts } = parsed.data;
    return (
      sourceId === canarySourceId &&
      facts.workflow === Stage0Canary.workflow &&
      typeof facts.branch === 'string' &&
      facts.branch.startsWith(Stage0Canary.idPrefix)
    );
  };
}
