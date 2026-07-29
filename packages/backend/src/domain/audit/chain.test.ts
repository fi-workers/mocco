import { AuditActions } from '@mocco/common/audit';
import { describe, expect, it } from 'vitest';

import { chainEntry, type AuditEntryInput } from '@backend/domain/audit/chain';

/** A representative entry the cases vary one field at a time from. */
const base: AuditEntryInput = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  actorUserId: '22222222-2222-2222-2222-222222222222',
  action: AuditActions.gateResumed,
  subjectType: 'run_gate',
  subjectId: 'gate-1',
  payload: { gateName: 'prod', roles: ['sre', 'deployer'] },
};

describe('chainEntry (pure)', () => {
  it('is deterministic — same input, same hash', () => {
    expect(chainEntry(null, base).hash).toBe(chainEntry(null, base).hash);
  });

  it('produces a 64-char hex sha-256 hash', () => {
    expect(chainEntry(null, base).hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is key-order-independent — payload keys in a different order hash the same', () => {
    const reordered: AuditEntryInput = {
      ...base,
      // Same content, keys inserted in the opposite order (and a nested array kept as-is).
      payload: { roles: ['sre', 'deployer'], gateName: 'prod' },
    };
    expect(chainEntry(null, reordered).hash).toBe(chainEntry(null, base).hash);
  });

  it('is field-sensitive — a changed payload changes the hash', () => {
    const mutated: AuditEntryInput = { ...base, payload: { ...base.payload, gateName: 'staging' } };
    expect(chainEntry(null, mutated).hash).not.toBe(chainEntry(null, base).hash);
  });

  it.each([
    ['workspaceId', { workspaceId: '33333333-3333-3333-3333-333333333333' }],
    ['actorUserId', { actorUserId: null }],
    ['action', { action: AuditActions.gateRejected }],
    ['subjectType', { subjectType: 'run' }],
    ['subjectId', { subjectId: 'gate-2' }],
  ] satisfies [string, Partial<AuditEntryInput>][])('is sensitive to %s', (_field, override) => {
    const mutated: AuditEntryInput = { ...base, ...override };
    expect(chainEntry(null, mutated).hash).not.toBe(chainEntry(null, base).hash);
  });

  it('respects array order (order is meaningful in a list)', () => {
    const swapped: AuditEntryInput = { ...base, payload: { ...base.payload, roles: ['deployer', 'sre'] } };
    expect(chainEntry(null, swapped).hash).not.toBe(chainEntry(null, base).hash);
  });

  it('folds prevHash in — the same entry chains differently after a different predecessor', () => {
    const first = chainEntry(null, base);
    const second = chainEntry(first.hash, base);
    // Identical content, but a non-null predecessor yields a distinct hash.
    expect(second.hash).not.toBe(first.hash);
    // And a null predecessor equals the empty-string predecessor (prevHash ?? '').
    expect(chainEntry(null, base).hash).toBe(chainEntry('', base).hash);
  });

  it('chains — entry N+1 binds to entry N (recomputable end-to-end)', () => {
    const entryA: AuditEntryInput = { ...base, subjectId: 'a' };
    const entryB: AuditEntryInput = { ...base, subjectId: 'b' };
    const a = chainEntry(null, entryA);
    const b = chainEntry(a.hash, entryB);
    // A verifier re-walking with the running prev reproduces the same head.
    expect(chainEntry(chainEntry(null, entryA).hash, entryB).hash).toBe(b.hash);
  });
});
