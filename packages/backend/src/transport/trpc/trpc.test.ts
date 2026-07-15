import { describe, expect, it } from 'vitest';

import { maskInternalError } from '@backend/transport/trpc/trpc';

describe('maskInternalError', () => {
  it('masks the message of an INTERNAL_SERVER_ERROR (never leak SQL/vendor detail)', () => {
    const shape = { message: 'Failed query: select "id" from "mocco_users" where email = $1', data: {} };
    expect(maskInternalError(shape, 'INTERNAL_SERVER_ERROR')).toEqual({ ...shape, message: 'Internal server error' });
  });

  it('preserves the message of an explicit domain error', () => {
    const shape = { message: 'Workspace name is required', data: {} };
    expect(maskInternalError(shape, 'BAD_REQUEST')).toBe(shape);
    expect(maskInternalError(shape, 'UNAUTHORIZED').message).toBe('Workspace name is required');
  });
});
