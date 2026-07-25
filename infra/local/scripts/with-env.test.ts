import { describe, expect, it } from 'vitest';

import { mergeEnv, parseDotenv } from './with-env';

describe('parseDotenv', () => {
  it('parses simple KEY=VALUE pairs', () => {
    expect(parseDotenv('FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('strips surrounding double quotes from the value', () => {
    expect(parseDotenv('FOO="bar"')).toEqual({ FOO: 'bar' });
  });

  it('strips surrounding single quotes from the value', () => {
    expect(parseDotenv("FOO='bar'")).toEqual({ FOO: 'bar' });
  });

  it('skips blank lines', () => {
    expect(parseDotenv('FOO=bar\n\nBAZ=qux')).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('skips comment lines starting with #', () => {
    expect(parseDotenv('# a comment\nFOO=bar\n# another\nBAZ=qux')).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('keeps subsequent = signs in the value (splits on first = only)', () => {
    expect(parseDotenv('K=a=b')).toEqual({ K: 'a=b' });
  });

  it('trims surrounding whitespace on key and value', () => {
    expect(parseDotenv('  FOO  =  bar  ')).toEqual({ FOO: 'bar' });
  });

  it('drops an inline # comment from an unquoted value', () => {
    expect(parseDotenv('SERVICE_DOMAIN=my-mac.ts.net # my laptop')).toEqual({
      SERVICE_DOMAIN: 'my-mac.ts.net',
    });
  });

  it('keeps a # inside a quoted value (not treated as a comment)', () => {
    expect(parseDotenv('PASS="a#b # c"')).toEqual({ PASS: 'a#b # c' });
  });

  it('keeps a leading # only when it is not preceded by a space (no false comment)', () => {
    expect(parseDotenv('COLOR=#ffffff')).toEqual({ COLOR: '#ffffff' });
  });
});

describe('mergeEnv', () => {
  it('lets override win when a key exists in both', () => {
    expect(mergeEnv({ FOO: 'base' }, { FOO: 'override' })).toEqual({
      FOO: 'override',
    });
  });

  it('keeps a key present only in base', () => {
    expect(mergeEnv({ FOO: 'base', BAR: 'only-base' }, { FOO: 'override' })).toEqual({
      FOO: 'override',
      BAR: 'only-base',
    });
  });
});
