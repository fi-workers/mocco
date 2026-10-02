import { AuditActions } from '@mocco/common/audit';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { FlagChangesetRow } from '@backend/domain/flags/repos/flag-changeset.repo';

/** Record `flag.restored` for each kill an applied changeset undid (#142). */
export async function auditRestores(
  audit: AuditService,
  workspaceId: string,
  actorUserId: string | null,
  changeset: FlagChangesetRow,
): Promise<void> {
  const restored = changeset.diff.filter(
    entry => entry.subject === 'flag' && entry.field === 'killed' && entry.before === true && entry.after === false,
  );
  await restored.reduce(async (previous, entry) => {
    await previous;
    await audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.flagRestored,
      subjectType: 'flag_environment',
      subjectId: changeset.environmentId,
      payload: {
        flagKey: entry.key,
        changesetId: changeset.id,
        version: changeset.appliedVersion,
        approvalRequestId: changeset.approvalRequestId,
      },
    });
  }, Promise.resolve());
}
