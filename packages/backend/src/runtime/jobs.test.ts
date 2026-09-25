import { JobStatuses } from '@mocco/common/jobs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventJobKinds } from '@backend/domain/events/EventBus';
import { InboundJobKinds } from '@backend/domain/inbound/jobs';
import { JobKinds } from '@backend/domain/jobs/prune';
import { jobs, jobSchedules } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createJobRunner } from '@backend/runtime/jobs';

const T0 = new Date('2026-09-25T00:00:00.000Z');

describe('job runtime composition (pglite)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  it('registers every domain handler and the platform schedules', async () => {
    const runner = createJobRunner(t.db, {
      now: () => T0,
      random: () => 0,
      workerId: 'test',
      waitUntil: () => {},
    });

    const report = await runner.tick({ budgetMs: 10_000, maxJobs: 10 });

    expect(report).toMatchObject({ ran: 4, errors: [], outcomes: { succeeded: 4 } });
    const schedules = await t.db.select().from(jobSchedules);
    expect(new Set(schedules.map(schedule => schedule.kind))).toEqual(
      new Set([JobKinds.prune, EventJobKinds.prune, InboundJobKinds.republishStale, InboundJobKinds.prune]),
    );
    expect(schedules.every(schedule => schedule.workspaceId === null)).toBe(true);
    const ran = await t.db.select().from(jobs);
    expect(ran.every(job => job.status === JobStatuses.succeeded)).toBe(true);
  });
});
