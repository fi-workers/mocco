/* eslint-disable no-bitwise -- a hash function is bit arithmetic by definition */
/**
 * MurmurHash3 x86_32 over the UTF-8 bytes of a string — the hash flagd's `fractional`
 * uses (Go's `murmur3.StringSum32`), so the same key lands in the same bucket in flagd
 * and in Mocco's SDKs. Returns an unsigned 32-bit integer.
 */
export function murmur3(input: string | Uint8Array, seed = 0): number {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const c1 = 0xcc_9e_2d_51;
  const c2 = 0x1b_87_35_93;
  const blocks = bytes.length >>> 2;
  let hash = seed >>> 0;

  for (let index = 0; index < blocks; index += 1) {
    const offset = index * 4;
    let k =
      (bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    hash ^= k;
    hash = (hash << 13) | (hash >>> 19);
    hash = (Math.imul(hash, 5) + 0xe6_54_6b_64) >>> 0;
  }

  const tail = blocks * 4;
  const remaining = bytes.length & 3;
  let k = 0;
  if (remaining === 3) {
    k ^= (bytes[tail + 2] ?? 0) << 16;
  }
  if (remaining >= 2) {
    k ^= (bytes[tail + 1] ?? 0) << 8;
  }
  if (remaining >= 1) {
    k ^= bytes[tail] ?? 0;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    hash ^= k;
  }

  hash ^= bytes.length;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85_eb_ca_6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2_b2_ae_35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}
