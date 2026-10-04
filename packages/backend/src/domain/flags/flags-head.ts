// The project as `.mocco/flags.yml` is planned against (#145, #146): its flags and each
// environment's current state. Shared by the sync on a push and the plan check on a PR,
// so a PR's report and the merge that follows plan against the same picture.
import { FlagEnvironmentRepo } from '@backend/domain/flags/repos/flag-environment.repo';
import { FlagRepo } from '@backend/domain/flags/repos/flag.repo';
import { readHead } from '@backend/domain/flags/RulesetPublisher';

import type { EnvironmentState } from '@backend/domain/flags/apply-ops';
import type { FlagsHead } from '@backend/domain/flags/flags-file';
import type { Db } from '@backend/infra/db/types';

/** The project's flags and each environment's state by key, with the environment rows. */
export async function readFlagsHead(db: Db, workspaceId: string, projectId: string) {
  const [flags, environments] = await Promise.all([
    new FlagRepo(db).listByProject(workspaceId, projectId),
    new FlagEnvironmentRepo(db).listByProject(workspaceId, projectId),
  ]);
  const states = await Promise.all(
    environments.map(async environment => {
      const head = await readHead(db, workspaceId, environment);
      const state: EnvironmentState = {
        configs: new Map([...head.configs].map(([key, { salt: _salt, ...config }]) => [key, config])),
        segments: head.segments,
        variants: new Map(head.flags.map(flag => [flag.key, Object.keys(flag.variants)])),
      };
      return [environment.key, state] as const;
    }),
  );
  const head: FlagsHead = {
    flags: new Map(
      flags.map(flag => [
        flag.key,
        {
          type: flag.type,
          variants: flag.variants,
          description: flag.description,
          lifecycle: flag.lifecycle,
          clientVisible: flag.clientVisible,
          managedBy: flag.managedBy,
        },
      ]),
    ),
    environments: new Map(states),
  };
  return { head, environments };
}
