// The release registry's service over a db. Pure (no instance imports): the event bus
// composition (domain/events/subscriptions.ts) and the job runtime (runtime/jobs.ts) both
// build it with their own bus.
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { ReleaseService } from '@backend/domain/project/ReleaseService';
import { ProjectRepoRepo } from '@backend/domain/project/repos/project-repo.repo';
import { ReleaseRepo } from '@backend/domain/project/repos/release.repo';

import type { EventPublisher } from '@backend/domain/events/ports';
import type { Db } from '@backend/infra/db/types';

export function createReleaseService(db: Db, deps: { bus: EventPublisher }): ReleaseService {
  return new ReleaseService({
    releases: new ReleaseRepo(db),
    projectRepos: new ProjectRepoRepo(db),
    runs: new RunRepo(db),
    runGates: new RunGateRepo(db),
    resumes: new ResumeRepo(db),
    bus: deps.bus,
  });
}
