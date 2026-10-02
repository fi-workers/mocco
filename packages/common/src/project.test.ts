import { describe, expect, it } from 'vitest';

import { webOriginSchema } from './project';

describe('webOriginSchema', () => {
  it('accepts a scheme and host (with a port), normalized to the origin', () => {
    expect(webOriginSchema.parse('https://app.acme.com')).toBe('https://app.acme.com');
    expect(webOriginSchema.parse('https://APP.acme.com/')).toBe('https://app.acme.com');
    expect(webOriginSchema.parse('http://localhost:5180')).toBe('http://localhost:5180');
  });

  it('refuses paths, other schemes and non-URLs', () => {
    const accepted = ['https://app.acme.com/checkout', 'mailto:ops@acme.com', 'app.acme.com', ''].filter(
      value => webOriginSchema.safeParse(value).success,
    );
    expect(accepted).toEqual([]);
  });
});
