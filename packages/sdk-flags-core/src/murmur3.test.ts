import { describe, expect, it } from 'vitest';

import { murmur3 } from './murmur3';

describe('murmur3 (x86_32)', () => {
  // Reference vectors for MurmurHash3_x86_32, cross-checked against murmurhash3js-revisited.
  it.each([
    ['', 0, 0],
    ['', 1, 0x51_4e_28_b7],
    ['', 0xff_ff_ff_ff, 0x81_f1_6f_39],
    ['\0\0\0\0', 0, 0x23_62_f9_de],
    ['aaaa', 0x97_47_b2_8c, 0x5a_97_80_8a],
    ['aaa', 0x97_47_b2_8c, 0x28_3e_01_30],
    ['aa', 0x97_47_b2_8c, 0x5d_21_17_26],
    ['a', 0x97_47_b2_8c, 0x7f_a0_9e_a6],
    ['abcd', 0x97_47_b2_8c, 0xf0_47_86_27],
    ['abc', 0x97_47_b2_8c, 0xc8_4a_62_dd],
    ['ab', 0x97_47_b2_8c, 0x74_87_55_92],
    ['Hello, world!', 0x97_47_b2_8c, 0x24_88_4c_ba],
    ['ππππππππ', 0x97_47_b2_8c, 0xd5_80_63_c1],
    ['The quick brown fox jumps over the lazy dog', 0x97_47_b2_8c, 0x2f_a8_26_cd],
  ])('hashes %j with seed %i', (input, seed, expected) => {
    expect(murmur3(input, seed)).toBe(expected);
  });
});
