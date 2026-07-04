/** Shared frontend/backend types. (Transition logic lives in backend/domain.) */
export type RunState =
  | 'Discovered'
  | 'Queued'
  | 'PendingResume'
  | 'Resumed'
  | 'ReadyToRun'
  | 'Dispatched'
  | 'Running'
  | 'Succeeded'
  | 'Failed'
  | 'Rejected'
  | 'Blocked'
  | 'VerifyFailed';

export const RUN_STATES: RunState[] = [
  'Discovered',
  'Queued',
  'PendingResume',
  'Resumed',
  'ReadyToRun',
  'Dispatched',
  'Running',
  'Succeeded',
  'Failed',
  'Rejected',
  'Blocked',
  'VerifyFailed',
];
