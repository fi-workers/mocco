import { describe, expect, it } from 'vitest';

import { EntityNotFoundError } from '@backend/infra/db/errors';
import { expectOne, getOrThrow } from '@backend/infra/db/rows';

describe('getOrThrow', () => {
  it('returns the first row', () => {
    expect(getOrThrow([{ id: 1 }, { id: 2 }], 'x')).toEqual({ id: 1 });
  });
  it('throws EntityNotFoundError with the message when empty', () => {
    expect(() => getOrThrow([], 'no row')).toThrow(EntityNotFoundError);
    expect(() => getOrThrow([], 'no row')).toThrow('no row');
  });
});

describe('expectOne', () => {
  it('returns the first row', () => {
    expect(expectOne([{ id: 1 }])).toEqual({ id: 1 });
  });
  it('throws a plain Error (not EntityNotFoundError) when empty', () => {
    expect(() => expectOne([])).toThrow(Error);
    expect(() => expectOne([])).not.toThrow(EntityNotFoundError);
  });
});
