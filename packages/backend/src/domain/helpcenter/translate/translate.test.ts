import { describe, expect, it } from 'vitest';

import { segmentMarkdown } from '@backend/domain/helpcenter/markdown/segment';
import { alignedSegments } from '@backend/domain/helpcenter/translate/align';
import { batchesOf, distinctByHash } from '@backend/domain/helpcenter/translate/pipeline';
import {
  ClaimDecisions,
  decideClaim,
  ResultTargets,
  resultTarget,
  stateWithoutResult,
} from '@backend/domain/helpcenter/translate/state';

import type { TranslationSnapshot } from '@backend/domain/helpcenter/translate/state';
import type { TranslationState } from '@mocco/common/help';

const NOW = new Date('2026-10-06T09:00:00Z');
const LATER = new Date('2026-10-06T09:05:00Z');
const EARLIER = new Date('2026-10-06T08:55:00Z');

const row = (state: TranslationState, extra: Partial<TranslationSnapshot> = {}): TranslationSnapshot => ({
  state,
  sourceHash: 'old',
  proposalSourceHash: null,
  claimedUntil: null,
  ...extra,
});

describe('translation state machine', () => {
  it.each([
    ['no row yet', undefined, ClaimDecisions.translate],
    ['pending', row('pending', { sourceHash: null }), ClaimDecisions.translate],
    ['failed', row('failed'), ClaimDecisions.translate],
    ['auto, made from this source', row('auto', { sourceHash: 'new' }), ClaimDecisions.upToDate],
    ['auto, stale', row('auto'), ClaimDecisions.translate],
    ['reviewed, made from this source', row('reviewed', { sourceHash: 'new' }), ClaimDecisions.upToDate],
    ['reviewed, stale', row('reviewed'), ClaimDecisions.propose],
    ['reviewed, stale, proposal ready', row('reviewed', { proposalSourceHash: 'new' }), ClaimDecisions.upToDate],
    ['held by another run', row('auto', { claimedUntil: LATER }), ClaimDecisions.busy],
    ['held by a run that died', row('translating', { claimedUntil: EARLIER }), ClaimDecisions.translate],
  ])('claims %s → %s', (_name, snapshot, decision) => {
    expect(decideClaim(snapshot, 'new', NOW)).toBe(decision);
  });

  it('translates an up-to-date auto translation again only when asked to start fresh', () => {
    expect(decideClaim(row('auto', { sourceHash: 'new' }), 'new', NOW, { fresh: true })).toBe(ClaimDecisions.translate);
    expect(decideClaim(row('reviewed', { sourceHash: 'new' }), 'new', NOW, { fresh: true })).toBe(
      ClaimDecisions.upToDate,
    );
  });

  it.each([
    ['still translating', row('translating'), ResultTargets.current],
    ['a person saved from this source meanwhile', row('reviewed', { sourceHash: 'new' }), ResultTargets.discard],
    ['reviewed and stale', row('reviewed'), ResultTargets.proposal],
  ])('lands a result when %s → %s (never over reviewed text)', (_name, snapshot, target) => {
    expect(resultTarget(snapshot, 'new')).toBe(target);
  });

  it('leaves the state it found when a run stops without a result', () => {
    expect(stateWithoutResult(row('translating'), 'auto', 'outage')).toBe('auto');
    expect(stateWithoutResult(row('translating'), 'pending', 'outage')).toBe('pending');
    expect(stateWithoutResult(row('translating'), undefined, 'outage')).toBe('pending');
    expect(stateWithoutResult(row('translating'), 'auto', 'allowance')).toBe('pending');
    expect(stateWithoutResult(row('reviewed'), 'reviewed', 'allowance')).toBe('reviewed');
    expect(stateWithoutResult(row('translating'), 'auto', 'refused')).toBe('failed');
    expect(stateWithoutResult(row('reviewed'), 'reviewed', 'refused')).toBe('reviewed');
  });
});

describe('aligning a person’s translation to the source', () => {
  const source = { title: 'Widget', body: '## Add it\n\nOpen [Settings](https://a.test) and tap `Add`.' };

  it('keeps each segment that lines up, renumbered to the source’s placeholders', () => {
    // The Korean puts the code before the link: the placeholders swap numbers.
    const translation = { title: '위젯', body: '## 추가하기\n\n`Add`를 누르기 전에 [설정](https://a.test)을 엽니다.' };
    const [, paragraph] = segmentMarkdown(source.body);

    const aligned = alignedSegments(source, translation);

    expect(paragraph?.text).toBe('Open ⟦0⟧Settings⟦/0⟧ and tap ⟦1⟧.');
    expect(aligned.map(entry => entry.text)).toEqual(['위젯', '추가하기', '⟦1⟧를 누르기 전에 ⟦0⟧설정⟦/0⟧을 엽니다.']);
  });

  it('drops segments it can’t place: another structure, or a changed link', () => {
    const restructured = { title: '위젯', body: '추가하기\n\n설정을 엽니다.\n\n하나 더.' };
    const relinked = { title: '위젯', body: '## 추가하기\n\n[설정](https://b.test)에서 `Add`를 누릅니다.' };

    expect(alignedSegments(source, restructured).map(entry => entry.text)).toEqual(['위젯']);
    expect(alignedSegments(source, relinked).map(entry => entry.text)).toEqual(['위젯', '추가하기']);
  });
});

describe('batching segments', () => {
  it('sends each distinct text once, in batches under the budget', () => {
    const segments = segmentMarkdown('One.\n\nTwo two.\n\nOne.\n\nThree three three.');
    const distinct = distinctByHash(segments);

    expect(distinct.map(segment => segment.text)).toEqual(['One.', 'Two two.', 'Three three three.']);
    expect(batchesOf(distinct, 12).map(batch => batch.map(segment => segment.text))).toEqual([
      ['One.', 'Two two.'],
      ['Three three three.'],
    ]);
  });
});
