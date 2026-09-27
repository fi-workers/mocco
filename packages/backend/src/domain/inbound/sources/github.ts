import { InboundEventTypes } from '@mocco/common/inbound';
import { Severities } from '@mocco/common/notification';
import { z } from 'zod';

import {
  buildMessage,
  firstLine,
  headerValue,
  HmacAlgorithms,
  ignored,
  IgnoredReasons,
  isValidHmacHex,
  mapped,
  nonEmpty,
  ownValue,
  parseJson,
  type MessageDraft,
  type ParsedInbound,
  sourceEventLabel,
  stripPrefix,
  truncate,
} from '@backend/domain/inbound/sources/shared';

import type { Facts } from '@mocco/common/inbound';

// Repository / organization webhooks (docs.github.com webhook-events-and-payloads),
// configured by the customer with a Mocco-generated secret. This is independent
// of the governance GitHub App webhook (domain/integration/github). Only the
// fields used are declared; zod ignores the rest.

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';
const EVENT_HEADER = 'x-github-event';
const DELIVERY_HEADER = 'x-github-delivery';

const GithubEvents = {
  ping: 'ping',
  push: 'push',
  pull_request: 'pull_request',
  issues: 'issues',
  release: 'release',
  workflow_run: 'workflow_run',
} as const;

const Actions = {
  opened: 'opened',
  reopened: 'reopened',
  closed: 'closed',
  published: 'published',
  completed: 'completed',
} as const;

const Conclusions = {
  failure: 'failure',
  timed_out: 'timed_out',
  startup_failure: 'startup_failure',
  success: 'success',
} as const;
const FAILED_CONCLUSIONS: ReadonlySet<string | null | undefined> = new Set([
  Conclusions.failure,
  Conclusions.timed_out,
  Conclusions.startup_failure,
]);

/** What a pushed ref is, as the `refType` fact. */
export const GithubRefTypes = { branch: 'branch', tag: 'tag' } as const;

const BRANCH_REF_PREFIX = 'refs/heads/';
const TAG_REF_PREFIX = 'refs/tags/';
const UNKNOWN_WORKFLOW = 'workflow';
const PUSH_COMMITS_SHOWN = 5;
const COMMIT_SUBJECT_MAX = 72;
const SHORT_SHA_LENGTH = 7;

const baseSchema = z.object({
  repository: z.object({ full_name: z.string().min(1) }),
  sender: z
    .object({ login: z.string(), html_url: z.string().optional(), avatar_url: z.string().optional() })
    .optional(),
});
type Base = z.infer<typeof baseSchema>;

const pushSchema = baseSchema.extend({
  ref: z.string(),
  compare: z.string().optional(),
  commits: z.array(z.object({ id: z.string(), message: z.string() })).default([]),
});

const pullRequestSchema = baseSchema.extend({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    title: z.string(),
    html_url: z.string(),
    merged: z.boolean().nullish(),
    head: z.object({ ref: z.string() }).optional(),
    base: z.object({ ref: z.string() }),
  }),
});

const issuesSchema = baseSchema.extend({
  action: z.string(),
  issue: z.object({ number: z.number(), title: z.string(), html_url: z.string() }),
});

const releaseSchema = baseSchema.extend({
  action: z.string(),
  release: z.object({ tag_name: z.string(), html_url: z.string() }),
});

const workflowRunSchema = baseSchema.extend({
  action: z.string(),
  workflow_run: z.object({
    name: z.string().nullish(),
    head_branch: z.string().nullish(),
    conclusion: z.string().nullish(),
    html_url: z.string(),
  }),
});

/** `X-Hub-Signature-256` is `sha256=` followed by the hex HMAC-SHA256 of the raw body. */
// eslint-disable-next-line unicorn/consistent-boolean-name -- the adapter contract names it verify
export function verify(rawBody: Uint8Array, headers: Headers, secret: string): boolean {
  const signature = headerValue(headers, SIGNATURE_HEADER);
  const hex = signature === undefined ? undefined : stripPrefix(signature, SIGNATURE_PREFIX);
  return hex !== undefined && isValidHmacHex(HmacAlgorithms.sha256, secret, rawBody, hex);
}

export function deliveryId(_rawBody: string, headers: Headers): string | undefined {
  return headerValue(headers, DELIVERY_HEADER);
}

/** Actor, footer and the repo fact every GitHub message shares. */
function chrome(body: Base) {
  const repo = body.repository.full_name;
  const { sender } = body;
  return {
    repo,
    draft: {
      actor:
        sender === undefined ? undefined : { name: sender.login, url: sender.html_url, avatarUrl: sender.avatar_url },
      footer: `GitHub · ${repo}`,
    } satisfies Partial<MessageDraft>,
  };
}

function shapeMismatch(event: string): ParsedInbound {
  return ignored(`github ${event} payload does not match the expected shape`);
}

function actionNotMapped(event: string, action: string): ParsedInbound {
  return ignored(`github ${event} action "${action}" is not mapped`);
}

function parsePush(json: unknown): ParsedInbound {
  const body = pushSchema.safeParse(json);
  if (!body.success) {
    return shapeMismatch(GithubEvents.push);
  }
  const { ref, compare, commits } = body.data;
  const { repo, draft } = chrome(body.data);
  const branch = stripPrefix(ref, BRANCH_REF_PREFIX);
  const refName = branch ?? stripPrefix(ref, TAG_REF_PREFIX) ?? ref;
  const count = commits.length;
  const lines = commits
    .slice(0, PUSH_COMMITS_SHOWN)
    .map(
      commit =>
        `\`${commit.id.slice(0, SHORT_SHA_LENGTH)}\` ${truncate(firstLine(commit.message), COMMIT_SUBJECT_MAX)}`,
    );
  if (count > PUSH_COMMITS_SHOWN) {
    lines.push(`…and ${count - PUSH_COMMITS_SHOWN} more`);
  }
  let summary = 'No new commits';
  if (count > 0) {
    summary = `${count} commit${count === 1 ? '' : 's'}`;
  }
  const message = buildMessage({
    ...draft,
    title: `${summary} · ${repo}:${refName}`,
    url: compare,
    description: lines.join('\n'),
    severity: Severities.info,
    fields: [],
  });
  const hasCommits = count > 0;
  const facts: Facts =
    branch === undefined
      ? { repo, refType: GithubRefTypes.tag, hasCommits }
      : { repo, refType: GithubRefTypes.branch, branch, hasCommits };
  return mapped(InboundEventTypes['github.push'], facts, message);
}

function parsePullRequest(json: unknown): ParsedInbound {
  const body = pullRequestSchema.safeParse(json);
  if (!body.success) {
    return shapeMismatch(GithubEvents.pull_request);
  }
  const { action, pull_request: pr } = body.data;
  const { repo, draft } = chrome(body.data);
  let outcome;
  if (action === Actions.opened) {
    outcome = { type: InboundEventTypes['github.pull_request.opened'], label: 'opened', severity: Severities.info };
  } else if (action === Actions.reopened) {
    outcome = { type: InboundEventTypes['github.pull_request.reopened'], label: 'reopened', severity: Severities.info };
  } else if (action === Actions.closed && pr.merged === true) {
    outcome = { type: InboundEventTypes['github.pull_request.merged'], label: 'merged', severity: Severities.success };
  } else if (action === Actions.closed) {
    outcome = { type: InboundEventTypes['github.pull_request.closed'], label: 'closed', severity: Severities.warning };
  } else {
    return actionNotMapped(GithubEvents.pull_request, action);
  }
  const branches = pr.head === undefined ? `\`${pr.base.ref}\`` : `\`${pr.head.ref}\` → \`${pr.base.ref}\``;
  const message = buildMessage({
    ...draft,
    title: `PR ${outcome.label}: ${pr.title} · ${repo}`,
    url: pr.html_url,
    severity: outcome.severity,
    fields: [
      { name: 'PR', value: `#${pr.number}`, inline: true },
      { name: 'Branch', value: branches, inline: true },
    ],
  });
  return mapped(outcome.type, { repo, baseBranch: pr.base.ref }, message);
}

function parseIssues(json: unknown): ParsedInbound {
  const body = issuesSchema.safeParse(json);
  if (!body.success) {
    return shapeMismatch(GithubEvents.issues);
  }
  const { action, issue } = body.data;
  const { repo, draft } = chrome(body.data);
  let outcome;
  switch (action) {
    case Actions.opened: {
      outcome = { type: InboundEventTypes['github.issues.opened'], severity: Severities.warning };

      break;
    }
    case Actions.reopened: {
      outcome = { type: InboundEventTypes['github.issues.reopened'], severity: Severities.warning };

      break;
    }
    case Actions.closed: {
      outcome = { type: InboundEventTypes['github.issues.closed'], severity: Severities.info };

      break;
    }
    default: {
      return actionNotMapped(GithubEvents.issues, action);
    }
  }
  const message = buildMessage({
    ...draft,
    title: `Issue ${action}: ${issue.title} · ${repo}`,
    url: issue.html_url,
    severity: outcome.severity,
    fields: [{ name: 'Issue', value: `#${issue.number}`, inline: true }],
  });
  return mapped(outcome.type, { repo }, message);
}

function parseRelease(json: unknown): ParsedInbound {
  const body = releaseSchema.safeParse(json);
  if (!body.success) {
    return shapeMismatch(GithubEvents.release);
  }
  const { action, release } = body.data;
  if (action !== Actions.published) {
    return actionNotMapped(GithubEvents.release, action);
  }
  const { repo, draft } = chrome(body.data);
  const message = buildMessage({
    ...draft,
    title: `Release ${release.tag_name} · ${repo}`,
    url: release.html_url,
    severity: Severities.success,
    fields: [],
  });
  return mapped(InboundEventTypes['github.release.published'], { repo }, message);
}

function parseWorkflowRun(json: unknown): ParsedInbound {
  const body = workflowRunSchema.safeParse(json);
  if (!body.success) {
    return shapeMismatch(GithubEvents.workflow_run);
  }
  const { action, workflow_run: run } = body.data;
  if (action !== Actions.completed) {
    return actionNotMapped(GithubEvents.workflow_run, action);
  }
  let outcome;
  if (FAILED_CONCLUSIONS.has(run.conclusion)) {
    outcome = { type: InboundEventTypes['github.workflow_run.failed'], label: 'failed', severity: Severities.error };
  } else if (run.conclusion === Conclusions.success) {
    outcome = {
      type: InboundEventTypes['github.workflow_run.succeeded'],
      label: 'succeeded',
      severity: Severities.success,
    };
  } else {
    return ignored(`github workflow_run conclusion "${run.conclusion ?? 'none'}" is not mapped`);
  }
  const { repo, draft } = chrome(body.data);
  const workflow = nonEmpty(run.name) ?? UNKNOWN_WORKFLOW;
  const branch = nonEmpty(run.head_branch);
  const message = buildMessage({
    ...draft,
    title: `CI ${outcome.label}: ${workflow} · ${repo}`,
    url: run.html_url,
    severity: outcome.severity,
    fields: [{ name: 'Branch', value: branch === undefined ? '' : `\`${branch}\``, inline: true }],
  });
  const facts: Facts = branch === undefined ? { repo, workflow } : { repo, branch, workflow };
  return mapped(outcome.type, facts, message);
}

const eventParsers: Record<string, (json: unknown) => ParsedInbound> = {
  [GithubEvents.push]: parsePush,
  [GithubEvents.pull_request]: parsePullRequest,
  [GithubEvents.issues]: parseIssues,
  [GithubEvents.release]: parseRelease,
  [GithubEvents.workflow_run]: parseWorkflowRun,
};

/** `<X-GitHub-Event>.<action>`, e.g. `pull_request.opened`, or just the event (`push`). */
export function sourceEvent(rawBody: string, headers: Headers): string | undefined {
  const event = headerValue(headers, EVENT_HEADER);
  return event === undefined ? undefined : sourceEventLabel(event, parseJson(rawBody));
}

/** Maps a delivery by its `X-GitHub-Event` header. */
export function parse(rawBody: string, headers: Headers): ParsedInbound {
  const event = headerValue(headers, EVENT_HEADER);
  if (event === undefined) {
    return ignored('missing X-GitHub-Event header');
  }
  if (event === GithubEvents.ping) {
    return ignored(GithubEvents.ping);
  }
  const parser = ownValue(eventParsers, event);
  if (parser === undefined) {
    return ignored(`github event "${event}" is not mapped`);
  }
  const json = parseJson(rawBody);
  if (json === undefined) {
    return ignored(IgnoredReasons.malformedJson);
  }
  return parser(json);
}
