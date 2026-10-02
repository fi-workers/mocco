// An environment's protection (#141, ADR 0023): its change gate, and pending requests to
// change it. Protecting applies at once; changing or removing a gate needs that gate.
import { FlagApprovalSubjects } from '@mocco/common/flags';
import { gateRequirementsSchema } from '@mocco/common/governance';
import { useState } from 'react';
import { z } from 'zod';

import { GateEditor, PendingGateRequests } from '@frontend/components/governance/gate-editor';
import { errorMessage } from '@frontend/components/notifications/notification-ui';
import { describeApprovalPolicy } from '@frontend/components/ota/policy-text';
import { Button } from '@frontend/components/ui/button';
import { trpc } from '@frontend/lib/trpc';

import type { FlagEnvironmentDto } from '@mocco/common/flags';

/** What a change-gate approval would set. */
const pinnedGateSchema = z.object({ gate: gateRequirementsSchema.nullable() });

export default function Protection({
  workspaceId,
  projectId,
  environment,
}: {
  workspaceId: string;
  projectId: string;
  environment: FlagEnvironmentDto;
}) {
  const utils = trpc.useUtils();
  const [isEditing, setIsEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const change = trpc.flags.setChangeGate.useMutation({
    onSuccess: async result => {
      setIsEditing(false);
      setNotice(
        result.outcome === 'pending_approval'
          ? 'Sent for approval under the current protection; it changes once approved.'
          : 'Protection updated.',
      );
      await utils.flags.environments.invalidate();
    },
  });

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">Protection</h2>
          <p className="text-xs text-muted-foreground">
            {environment.changeGate === null
              ? `Changes to ${environment.name} apply at once. Protect it to require approval.`
              : `Changes to ${environment.name} need ${describeApprovalPolicy(environment.changeGate)}. Changing this protection needs it too.`}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 text-xs"
          onClick={() => {
            setIsEditing(previous => !previous);
          }}>
          {isEditing ? 'Close' : 'Edit protection'}
        </Button>
      </div>
      {isEditing ? (
        <GateEditor
          workspaceId={workspaceId}
          current={environment.changeGate}
          subjectNoun="environment"
          isPending={change.isPending}
          onSubmit={gate => {
            setNotice(null);
            change.mutate({ workspaceId, projectId, environmentId: environment.id, gate });
          }}
        />
      ) : null}
      {notice === null ? null : <p className="text-xs text-muted-foreground">{notice}</p>}
      {change.error ? <p className="text-sm text-destructive">{errorMessage(change.error)}</p> : null}
      <PendingGateRequests
        workspaceId={workspaceId}
        subjectType={FlagApprovalSubjects.changeGate}
        subjectId={environment.id}
        gateOf={action => {
          const pinned = pinnedGateSchema.safeParse(action);
          return pinned.success ? pinned.data.gate : undefined;
        }}
        onDecided={async () => {
          await utils.flags.environments.invalidate();
        }}
      />
    </section>
  );
}
