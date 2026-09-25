import { DomainEventTypes, domainEventPayloadSchemas } from '@mocco/common/events';
import { NeutralMessageLimits, Severities } from '@mocco/common/notification';
import { describe, expect, it } from 'vitest';

import { MOCCO_FOOTER, renderEventMessage } from '@backend/domain/notification/templates';

import type { DeliveredEvent } from '@backend/domain/events/EventBus';
import type { DomainEventType } from '@mocco/common/events';
import type { NeutralMessage } from '@mocco/common/notification';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const CONTEXT = { appOrigin: 'https://www.mocco.club' };
const RUN_LINK = `https://www.mocco.club/workspaces/${WORKSPACE}/runs/${RUN}`;

const runSubject = {
  workspaceId: WORKSPACE,
  runId: RUN,
  repoFullName: 'fi-workers/api',
  pipelineName: 'deploy',
  commitSha: 'abcdef1234567890',
  linkPath: `/workspaces/${WORKSPACE}/runs/${RUN}`,
  triggeredByName: 'Andrea',
};
const gateSubject = {
  ...runSubject,
  gateName: 'production',
  gateItemIndex: 2,
  facts: { repo: 'fi-workers/api', pipeline: 'deploy', gate: 'production' },
};

/** A delivered event as the bus hands it over: the payload parsed by the catalog. */
function delivered<T extends DomainEventType>(type: T, payload: unknown): DeliveredEvent {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    seq: 1n,
    workspaceId: WORKSPACE,
    projectId: null,
    type,
    subjectType: 'run',
    subjectId: RUN,
    payload: domainEventPayloadSchemas[type].parse(payload),
    dedupeKey: null,
    occurredAt: new Date('2026-09-25T00:00:00.000Z'),
    createdAt: new Date('2026-09-25T00:00:00.000Z'),
    // The parse above makes the payload match its type.
  } as DeliveredEvent;
}

const rejected = (reason: string | null) =>
  renderEventMessage(delivered(DomainEventTypes.gateRejected, { ...gateSubject, actorUserId: USER, reason }), CONTEXT);

const failed = (logsUrl: string | null) =>
  renderEventMessage(
    delivered(DomainEventTypes.runFailed, {
      ...runSubject,
      facts: { repo: 'fi-workers/api', pipeline: 'deploy' },
      failedStep: { name: 'migrate', index: 1 },
      logsUrl,
    }),
    CONTEXT,
  );

// The inbound types join the catalog with the ingest slice (#243); until then an
// inbound event is built by hand here, as the bus would hand it over.
const inbound = (payload: unknown) =>
  ({
    id: '55555555-5555-4555-8555-555555555555',
    workspaceId: WORKSPACE,
    type: 'sentry.issue.created',
    payload,
  }) as unknown as DeliveredEvent;

const fieldValue = (message: NeutralMessage, name: string) => message.fields.find(field => field.name === name)?.value;

describe('renderEventMessage (governance)', () => {
  it('renders gate.pending with the gate, its requirements and a link to the run', () => {
    const message = renderEventMessage(
      delivered(DomainEventTypes.gatePending, {
        ...gateSubject,
        requirements: [
          { role: 'deployer', count: 2 },
          { role: 'sre', count: 1 },
        ],
      }),
      CONTEXT,
    );
    expect(message).toMatchObject({
      title: 'Approval needed: deploy · production',
      url: RUN_LINK,
      severity: Severities.warning,
      description: 'fi-workers/api is waiting at gate "production".',
      footer: MOCCO_FOOTER,
    });
    expect(fieldValue(message, 'Repository')).toBe('fi-workers/api');
    expect(fieldValue(message, 'Commit')).toBe('abcdef1');
    expect(fieldValue(message, 'Triggered by')).toBe('Andrea');
    expect(fieldValue(message, 'Needs')).toBe('2 × deployer, 1 × sre');
  });

  it('omits the requirements and the trigger when the payload has none', () => {
    const message = renderEventMessage(
      delivered(DomainEventTypes.gatePending, { ...gateSubject, triggeredByName: null }),
      CONTEXT,
    );
    expect(fieldValue(message, 'Needs')).toBeUndefined();
    expect(fieldValue(message, 'Triggered by')).toBeUndefined();
  });

  it('renders gate.resumed with the votes counted per role', () => {
    const message = renderEventMessage(
      delivered(DomainEventTypes.gateResumed, {
        ...gateSubject,
        actorUserId: USER,
        resumedBy: [
          { userId: USER, role: 'deployer' },
          { userId: RUN, role: 'deployer' },
          { userId: WORKSPACE, role: 'sre' },
        ],
      }),
      CONTEXT,
    );
    expect(message).toMatchObject({ title: 'Gate resumed: deploy · production', severity: Severities.success });
    expect(fieldValue(message, 'Resumed by')).toBe('2 × deployer, 1 × sre');
  });

  it('renders gate.rejected with the reason, or says none was given', () => {
    expect(rejected('Freeze week')).toMatchObject({
      title: 'Gate rejected: deploy · production',
      severity: Severities.error,
      description: 'Freeze week',
    });
    expect(rejected(null).description).toBe('No reason given.');
  });

  it('renders run.succeeded', () => {
    const message = renderEventMessage(
      delivered(DomainEventTypes.runSucceeded, {
        ...runSubject,
        facts: { repo: 'fi-workers/api', pipeline: 'deploy' },
      }),
      CONTEXT,
    );
    expect(message).toMatchObject({ title: 'Run succeeded: deploy', url: RUN_LINK, severity: Severities.success });
  });

  it('renders run.failed with the failed step and an http(s) logs link only', () => {
    const message = failed('https://github.com/fi-workers/api/actions/runs/1');
    expect(message).toMatchObject({
      title: 'Run failed: deploy',
      severity: Severities.error,
      description: 'Step 2 "migrate" failed.',
    });
    expect(fieldValue(message, 'Logs')).toBe('https://github.com/fi-workers/api/actions/runs/1');
    // eslint-disable-next-line no-script-url -- the hostile input under test
    expect(fieldValue(failed('javascript:alert(1)'), 'Logs')).toBeUndefined();
    expect(fieldValue(failed(null), 'Logs')).toBeUndefined();
  });

  it('keeps a message with very long names inside the NeutralMessage limits', () => {
    const long = 'p'.repeat(5000);
    const message = renderEventMessage(
      delivered(DomainEventTypes.gatePending, {
        ...gateSubject,
        pipelineName: long,
        gateName: long,
        facts: { ...gateSubject.facts, pipeline: long, gate: long },
      }),
      CONTEXT,
    );
    expect(message.title.length).toBeLessThanOrEqual(NeutralMessageLimits.title);
    expect(message.description?.length).toBeLessThanOrEqual(NeutralMessageLimits.description);
    expect(message.fields.every(field => field.value.length <= NeutralMessageLimits.fieldValue)).toBe(true);
  });
});

describe('renderEventMessage (inbound)', () => {
  const inboundMessage: NeutralMessage = {
    title: 'TypeError in checkout',
    url: 'https://sentry.io/issues/1',
    severity: Severities.error,
    fields: [{ name: 'Project', value: 'shop' }],
    footer: 'Sentry',
  };

  it('uses the message the adapter rendered at ingest', () => {
    const payload = { sourceId: RUN, facts: { project: 'shop' }, message: inboundMessage };
    expect(renderEventMessage(inbound(payload), CONTEXT)).toEqual(inboundMessage);
  });

  it('rejects an inbound payload without a valid message', () => {
    expect(() => renderEventMessage(inbound({ sourceId: RUN, facts: {} }), CONTEXT)).toThrow();
    expect(() =>
      renderEventMessage(inbound({ sourceId: RUN, facts: {}, message: { ...inboundMessage, title: '' } }), CONTEXT),
    ).toThrow();
  });
});
