import { describe, expect, it } from 'vitest';

import { inboundReceiptsQuerySchema, inboundSeqCursorSchema } from './inbound';

describe('inboundSeqCursorSchema', () => {
  it('accepts digit strings within the Postgres bigint range', () => {
    expect(inboundSeqCursorSchema.parse('1')).toBe('1');
    expect(inboundSeqCursorSchema.parse('9223372036854775807')).toBe('9223372036854775807');
  });

  it('rejects an overflow, too many digits, signs and non-digits', () => {
    expect(inboundSeqCursorSchema.safeParse('9223372036854775808').success).toBe(false);
    expect(inboundSeqCursorSchema.safeParse('99999999999999999999').success).toBe(false);
    expect(inboundSeqCursorSchema.safeParse('-1').success).toBe(false);
    expect(inboundSeqCursorSchema.safeParse('').success).toBe(false);
    expect(inboundSeqCursorSchema.safeParse('1e3').success).toBe(false);
  });

  it('is what the receipts query validates beforeSeq with', () => {
    expect(inboundReceiptsQuerySchema.safeParse({ beforeSeq: '9223372036854775808' }).success).toBe(false);
    expect(inboundReceiptsQuerySchema.parse({ beforeSeq: '42' })).toMatchObject({ beforeSeq: '42', limit: 50 });
  });
});
