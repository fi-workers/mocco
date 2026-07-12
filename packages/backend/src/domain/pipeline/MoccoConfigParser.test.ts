import { describe, it, expect } from 'vitest';

import { MoccoConfigParser } from './MoccoConfigParser';
import { decodeYaml } from './yaml/decode';

const parser = new MoccoConfigParser(decodeYaml);
const good = `version: 1
pipeline: deploy
steps:
  - run: build
    executor: generic`;

describe('MoccoConfigParser', () => {
  it('parses a valid config', () => {
    const r = parser.parse(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.pipeline).toBe('deploy');
  });
  it('reports YAML syntax errors with a line', () => {
    const r = parser.parse('version: 1\n  bad: [');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe('yaml');
      expect(r.issues[0]?.line).toBeGreaterThan(0);
    }
  });
  it('reports schema errors with a path', () => {
    const r = parser.parse('version: 1\npipeline: p\nsteps: []');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe('schema');
      expect(r.issues.some(i => i.path.startsWith('steps'))).toBe(true);
    }
  });
});
