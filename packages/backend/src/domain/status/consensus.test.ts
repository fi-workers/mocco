import { CheckOutcomes, MonitorStates, QuorumModes, RoundVerdicts } from '@mocco/common/status';
import { describe, expect, it } from 'vitest';

import { failQuorumFor, nextState, quorumFor, tallyRound } from '@backend/domain/status/consensus';

import type { MachineState } from '@backend/domain/status/consensus';
import type { MonitorState, QuorumMode, RoundVerdict } from '@mocco/common/status';

const { ok, fail } = CheckOutcomes;
const ok100 = { outcome: ok, latencyMs: 100 };
const ok900 = { outcome: ok, latencyMs: 900 };
const failed = { outcome: fail, latencyMs: null };
const { up, suspect, down, recovering, degraded, pending, paused } = MonitorStates;
const V = RoundVerdicts;

describe('quorumFor', () => {
  it.each<[QuorumMode, number, number]>([
    [QuorumModes.majority, 0, 1],
    [QuorumModes.majority, 1, 1],
    [QuorumModes.majority, 2, 1],
    [QuorumModes.majority, 3, 2],
    [QuorumModes.majority, 4, 2],
    [QuorumModes.any, 5, 1],
    [QuorumModes.all, 3, 3],
    [QuorumModes.all, 0, 1],
  ])('%s of %i reporting needs %i', (mode, reporting, quorum) => {
    expect(quorumFor(mode, reporting)).toBe(quorum);
  });
});

describe('failQuorumFor', () => {
  it.each<[QuorumMode, number, number, number]>([
    [QuorumModes.majority, 1, 1, 1],
    [QuorumModes.majority, 1, 3, 2],
    [QuorumModes.majority, 2, 2, 2],
    [QuorumModes.majority, 3, 3, 2],
    [QuorumModes.majority, 6, 6, 3],
    [QuorumModes.all, 1, 2, 2],
    [QuorumModes.all, 3, 3, 3],
    [QuorumModes.any, 1, 3, 1],
  ])('%s of %i reporting (%i assigned) fails with %i failing', (mode, reporting, assigned, quorum) => {
    expect(failQuorumFor(mode, reporting, assigned)).toBe(quorum);
  });
});

describe('tallyRound', () => {
  const tally = (
    reports: Parameters<typeof tallyRound>[0],
    assigned: number,
    quorumMode: QuorumMode = QuorumModes.majority,
    latencyThresholdMs?: number,
  ) => tallyRound(reports, { assigned, quorumMode, latencyThresholdMs });

  it.each<[string, Parameters<typeof tallyRound>[0], number, QuorumMode, number | undefined, RoundVerdict]>([
    // One location still goes through the quorum: a quorum of one.
    ['single location passes', [ok100], 1, QuorumModes.majority, undefined, V.ok],
    ['single location fails', [failed], 1, QuorumModes.majority, undefined, V.fail],
    ['single location silent', [], 1, QuorumModes.majority, undefined, V.unknown],
    ['three silent: all no_data', [], 3, QuorumModes.majority, undefined, V.unknown],
    ['two of three fail', [failed, failed, ok100], 3, QuorumModes.majority, undefined, V.fail],
    ['one of three fails', [failed, ok100, ok100], 3, QuorumModes.majority, undefined, V.ok],
    [
      'a tie of four under majority is a failure',
      [failed, failed, ok100, ok100],
      4,
      QuorumModes.majority,
      undefined,
      V.fail,
    ],
    ['a tie of two is one failing region: never a failure', [failed, ok100], 2, QuorumModes.majority, undefined, V.ok],
    ['one failure of one reporting, two silent: unknown', [failed], 3, QuorumModes.majority, undefined, V.unknown],
    ['all mode: one failure of one reporting, one silent', [failed], 2, QuorumModes.all, undefined, V.unknown],
    ['any mode: one failure of one reporting, two silent', [failed], 3, QuorumModes.any, undefined, V.fail],
    ['all mode: one failure is not a quorum', [failed, ok100, ok100], 3, QuorumModes.all, undefined, V.unknown],
    ['all mode: everyone fails', [failed, failed], 3, QuorumModes.all, undefined, V.fail],
    ['any mode: one failure is enough', [failed, ok100, ok100], 3, QuorumModes.any, undefined, V.fail],
    ['slow by quorum is degraded', [ok900, ok900, ok100], 3, QuorumModes.majority, 500, V.degraded],
    ['one slow location is not degraded', [ok900, ok100, ok100], 3, QuorumModes.majority, 500, V.ok],
    ['no threshold is never degraded', [ok900], 1, QuorumModes.majority, undefined, V.ok],
  ])('%s', (_name, reports, assigned, mode, threshold, verdict) => {
    expect(tally(reports, assigned, mode, threshold).verdict).toBe(verdict);
  });

  it('counts silent locations as no_data and takes the median latency of passing checks', () => {
    expect(tally([ok100, ok900, failed], 5)).toEqual({
      verdict: V.ok,
      okCount: 2,
      failCount: 1,
      noDataCount: 2,
      p50LatencyMs: 500,
    });
    expect(tally([], 2)).toMatchObject({ noDataCount: 2, p50LatencyMs: null });
  });
});

describe('nextState', () => {
  const opts = { confirmations: 2, recoveryConfirmations: 2 };
  /** Run verdicts in order from a state, returning each state reached and whether it rechecks. */
  const run = (from: MonitorState, verdicts: RoundVerdict[], settings = opts) => {
    let current: MachineState = { state: from, consecutiveFails: 0, consecutiveOks: 0 };
    return verdicts.map(verdict => {
      const next = nextState(current, verdict, settings);
      current = next;
      return next.recheck ? `${next.state}!` : next.state;
    });
  };

  it.each<[string, MonitorState, RoundVerdict[], string[]]>([
    ['pending settles on the first verdict', pending, [V.ok], [up]],
    ['pending stays pending while nothing is known', pending, [V.unknown, V.unknown], [pending, pending]],
    ['up → suspect (recheck) → down after two confirmations', up, [V.fail, V.fail], [`${suspect}!`, down]],
    ['a passing recheck clears suspect', up, [V.fail, V.ok], [`${suspect}!`, up]],
    ['down → recovering → up after two recovery confirmations', down, [V.ok, V.ok], [recovering, up]],
    ['a failure while recovering is down again', down, [V.ok, V.fail, V.ok, V.ok], [recovering, down, recovering, up]],
    ['unknown never moves the state', up, [V.unknown, V.fail, V.unknown, V.fail], [up, `${suspect}!`, suspect, down]],
    ['all no_data while down stays down', down, [V.unknown, V.unknown], [down, down]],
    ['flapping never confirms an outage', up, [V.fail, V.ok, V.fail, V.ok], [`${suspect}!`, up, `${suspect}!`, up]],
    ['slow rounds are degraded, and recover to up', up, [V.degraded, V.ok], [degraded, up]],
    ['a failure while degraded is suspect', degraded, [V.fail], [`${suspect}!`]],
    ['down recovering to slow settles degraded', down, [V.degraded, V.degraded], [recovering, degraded]],
    ['paused is never evaluated', paused, [V.fail, V.ok], [paused, paused]],
  ])('%s', (_name, from, verdicts, states) => {
    expect(run(from, verdicts)).toEqual(states);
  });

  it('goes down on the first failure with one confirmation, and up on the first pass with one recovery', () => {
    expect(run(up, [V.fail, V.ok], { confirmations: 1, recoveryConfirmations: 1 })).toEqual([down, up]);
  });

  it('keeps streaks across unknown rounds and resets them on the opposite verdict', () => {
    const after = nextState({ state: suspect, consecutiveFails: 1, consecutiveOks: 0 }, V.unknown, opts);
    expect(after).toEqual({ state: suspect, consecutiveFails: 1, consecutiveOks: 0, recheck: false });
    expect(nextState(after, V.ok, opts)).toMatchObject({ consecutiveFails: 0, consecutiveOks: 1 });
  });
});

/**
 * Whole rounds from the regions' side (#151): each round is one character per assigned region,
 * `o` passed, `f` failed, `-` sent nothing (`no_data`). Every round is tallied and fed to the
 * state machine, as the evaluator does, with two confirmations either way.
 */
/** A region's report in a round string: `o` passed, `f` failed, anything else none. */
const reportOf = (region: string): Parameters<typeof tallyRound>[0] => {
  if (region === 'o') {
    return [ok100];
  }
  return region === 'f' ? [failed] : [];
};

describe('multi-region rounds through tally and state machine', () => {
  const opts = { confirmations: 2, recoveryConfirmations: 2 };
  const play = (from: MonitorState, quorumMode: QuorumMode, rounds: string[]) => {
    let current: MachineState = { state: from, consecutiveFails: 0, consecutiveOks: 0 };
    return rounds.map(round => {
      const regions = [...round];
      const { verdict } = tallyRound(
        regions.flatMap(region => reportOf(region)),
        {
          assigned: regions.length,
          quorumMode,
          latencyThresholdMs: undefined,
        },
      );
      current = nextState(current, verdict, opts);
      return current.state;
    });
  };
  const { majority, any, all } = QuorumModes;

  it.each<[string, MonitorState, QuorumMode, string[], MonitorState[]]>([
    // A partial region outage: one region fails every round, the others pass.
    ['one region of three down for good stays up', up, majority, ['foo', 'foo', 'foo', 'foo'], [up, up, up, up]],
    ['one region of six down for good stays up', up, majority, ['fooooo', 'fooooo', 'fooooo'], [up, up, up]],
    ['one region down and another silent stays up', up, majority, ['fo-', 'fo-', 'fo-'], [up, up, up]],
    ['one region down and the others silent: unknown, nothing moves', up, majority, ['f--', 'f--'], [up, up]],
    ['two regions of two down is an outage', up, majority, ['ff', 'ff'], [suspect, down]],
    ['one region down, one silent, two passing stays up', up, majority, ['foo-', 'foo-', 'foo-'], [up, up, up]],
    ['the failing region changing every round stays up', up, majority, ['foo', 'ofo', 'oof', 'foo'], [up, up, up, up]],
    ['a real outage: every region fails twice', up, majority, ['fff', 'fff'], [suspect, down]],
    ['two regions of three fail twice', up, majority, ['ffo', 'off'], [suspect, down]],
    // Flapping: failures that never line up two rounds in a row never confirm.
    [
      'flapping by quorum never confirms',
      up,
      majority,
      ['ffo', 'ooo', 'ffo', 'ooo', 'off', 'ooo'],
      [suspect, up, suspect, up, suspect, up],
    ],
    [
      'flapping while recovering stays in the outage',
      down,
      majority,
      ['ooo', 'fff', 'ooo', 'ooo'],
      [recovering, down, recovering, up],
    ],
    // All no_data: nobody reported, nothing is known, nothing moves.
    ['all no_data while up stays up', up, majority, ['---', '---', '---'], [up, up, up]],
    ['all no_data while down stays down', down, majority, ['---', '---'], [down, down]],
    ['all no_data between failures keeps the streak', up, majority, ['fff', '---', 'fff'], [suspect, suspect, down]],
    ['all no_data while pending stays pending', pending, majority, ['---', '---'], [pending, pending]],
    // The other modes.
    ['any: one region failing twice is an outage', up, any, ['foo', 'foo'], [suspect, down]],
    ['all: one region failing never is', up, all, ['foo', 'foo', 'foo'], [up, up, up]],
    ['all: every reporting region failing is, with one silent', up, all, ['ff-', 'ff-'], [suspect, down]],
  ])('%s', (_name, from, mode, rounds, states) => {
    expect(play(from, mode, rounds)).toEqual(states);
  });
});
