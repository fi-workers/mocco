// The translation state machine (#212), as pure decisions the service applies under the
// translation's advisory lock. A run is claimed (`claimed_until`), then its result lands:
//
//   pending | failed | (none) ──claim──▶ translating ──valid──▶ auto
//   auto (stale) ─────────────claim──▶ translating ──refused──▶ failed
//   reviewed (stale) ─────────claim──▶ reviewed + proposal (a draft; the text stays)
//   translating ──outage──▶ back to what it was;  ──over the allowance──▶ pending (reason)
//
// Invariant: a result never replaces the text of a `reviewed` translation. A person who
// saves while a run is out wins; the run's text becomes a proposal, or is dropped when
// the person's text already follows the current source.
//
// "Made from" is a pair: the published source's content hash and the article's glossary
// hash in that language (translate/glossary.ts). A glossary edit that changes the second
// makes a translation out of date the same way a source edit does.
import { TranslationStates } from '@mocco/common/help';

import type { TranslationState } from '@mocco/common/help';

/** The parts of a translation row the decisions read. */
export interface TranslationSnapshot {
  readonly state: TranslationState;
  readonly sourceHash: string | null;
  readonly proposalSourceHash: string | null;
  readonly glossaryHash: string;
  readonly proposalGlossaryHash: string | null;
  readonly claimedUntil: Date | null;
}

/** What a run translates from: the published source's hash and the article's glossary hash. */
export interface TranslationBasis {
  readonly sourceHash: string;
  readonly glossaryHash: string;
}

const isTextFrom = (row: TranslationSnapshot, basis: TranslationBasis) =>
  row.sourceHash === basis.sourceHash && row.glossaryHash === basis.glossaryHash;

const isProposalFrom = (row: TranslationSnapshot, basis: TranslationBasis) =>
  row.proposalSourceHash === basis.sourceHash && row.proposalGlossaryHash === basis.glossaryHash;

export const ClaimDecisions = {
  /** Machine text replaces the current text: becomes `translating`, then `auto` or `failed`. */
  translate: 'translate',
  /** A stale reviewed translation: draft a proposal, keep the person's text. */
  propose: 'propose',
  /** Another run holds it: try again after its claim ends. */
  busy: 'busy',
  /** Nothing to do: the text (or the proposal) already follows the current source. */
  upToDate: 'upToDate',
} as const;
export type ClaimDecision = (typeof ClaimDecisions)[keyof typeof ClaimDecisions];

/** What a job run should do with a translation, given what it would translate from. */
export function decideClaim(
  row: TranslationSnapshot | undefined,
  basis: TranslationBasis,
  now: Date,
  opts: { fresh?: boolean } = {},
): ClaimDecision {
  if (row?.claimedUntil !== null && row?.claimedUntil !== undefined && row.claimedUntil > now) {
    return ClaimDecisions.busy;
  }
  if (row === undefined) {
    return ClaimDecisions.translate;
  }
  if (row.state === TranslationStates.reviewed) {
    return isTextFrom(row, basis) || isProposalFrom(row, basis) ? ClaimDecisions.upToDate : ClaimDecisions.propose;
  }
  if (row.state === TranslationStates.auto && isTextFrom(row, basis) && opts.fresh !== true) {
    return ClaimDecisions.upToDate;
  }
  return ClaimDecisions.translate;
}

export const ResultTargets = {
  /** The new current text: the translation becomes `auto`. */
  current: 'current',
  /** A proposal beside a person's text. */
  proposal: 'proposal',
  /** Dropped: a person's text already follows this source. */
  discard: 'discard',
} as const;
export type ResultTarget = (typeof ResultTargets)[keyof typeof ResultTargets];

/** Where a finished run's text goes, given the row as it is now (a person may have saved meanwhile). */
export function resultTarget(rowNow: TranslationSnapshot | undefined, basis: TranslationBasis): ResultTarget {
  if (rowNow?.state !== TranslationStates.reviewed) {
    return ResultTargets.current;
  }
  return isTextFrom(rowNow, basis) ? ResultTargets.discard : ResultTargets.proposal;
}

/** The state a run leaves behind when it stops without a result: an outage, the allowance, or a refused segment. */
export function stateWithoutResult(
  rowNow: TranslationSnapshot | undefined,
  before: TranslationState | undefined,
  reason: 'outage' | 'allowance' | 'refused',
): TranslationState {
  if (rowNow?.state === TranslationStates.reviewed) {
    return TranslationStates.reviewed;
  }
  if (reason === 'allowance') {
    return TranslationStates.pending;
  }
  if (reason === 'refused') {
    return TranslationStates.failed;
  }
  return before === undefined || before === TranslationStates.translating ? TranslationStates.pending : before;
}

/** How a translation run ended. */
export const TranslationOutcomes = {
  /** The language has new machine text (`auto`). */
  translated: 'translated',
  /** A reviewed language got a proposal; its text is unchanged. */
  proposed: 'proposed',
  /** Nothing to do: already made from the current source (or another run already did it). */
  upToDate: 'upToDate',
  /** Another run holds the translation until `retryAt`. */
  busy: 'busy',
  /** A segment was refused after its last try: `failed`, nothing published. */
  refused: 'refused',
  /** The monthly allowance is used up: `pending` with the reason, nothing sent. */
  overAllowance: 'overAllowance',
  /** No translator, or the article isn't published. */
  skipped: 'skipped',
} as const;
export type TranslationOutcome = (typeof TranslationOutcomes)[keyof typeof TranslationOutcomes];
