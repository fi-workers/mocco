// What a device gets from the manifest endpoint (OTA design §6.1), as a pure function of
// the channel head it asks about. Devices load only a strictly newer `commitTime`, so a
// rollout can only move devices forward; rollback is a newer pre-signed republish.
import { createHash } from 'node:crypto';

/** A signed body the endpoint serves byte for byte. */
export interface SignedPart {
  id: string;
  body: string;
  signature: string | null;
  keyid: string | null;
}

/** The serving state of one (channel, platform, runtime) head. */
export interface HeadState {
  active: SignedPart | null;
  candidate: SignedPart | null;
  /** Basis points of devices that get the candidate (0..10000). */
  rolloutBp: number;
  rolloutSalt: string;
  isPaused: boolean;
  /** Set while the head serves a roll-back-to-embedded directive. */
  directive: SignedPart | null;
}

export interface SelectInput {
  head: HeadState | undefined;
  clientId: string | undefined;
  currentUpdateId: string | undefined;
}

export type Selection =
  { kind: 'update'; part: SignedPart } | { kind: 'directive'; part: SignedPart } | { kind: 'noop' };

const BASIS_POINTS = 10_000;

/** A device's stable rollout bucket, 0..9999, from the head's salt and its EAS-Client-ID. */
export function rolloutBucket(salt: string, clientId: string): number {
  return createHash('sha256').update(`${salt}:${clientId}`).digest().readUInt32BE(0) % BASIS_POINTS;
}

/**
 * 1. No head → noop. 2. A directive → the directive. 3. The candidate for devices in the
 * rollout (not paused; a device without EAS-Client-ID is always control), else the active
 * update. 4. Nothing to serve, or the device already runs it → noop. 5. The update.
 *
 * sonarjs/function-return-type is a false positive: every branch returns a `Selection`.
 */
// eslint-disable-next-line sonarjs/function-return-type
export function selectResponse(input: SelectInput): Selection {
  const { head, clientId, currentUpdateId } = input;
  if (head === undefined) {
    return { kind: 'noop' };
  }
  if (head.directive !== null) {
    return { kind: 'directive', part: head.directive };
  }
  const isInRollout =
    !head.isPaused &&
    head.candidate !== null &&
    clientId !== undefined &&
    rolloutBucket(head.rolloutSalt, clientId) < head.rolloutBp;
  const target = isInRollout ? head.candidate : head.active;
  if (target === null || target.id === currentUpdateId) {
    return { kind: 'noop' };
  }
  return { kind: 'update', part: target };
}
