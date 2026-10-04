import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  clean: true,
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  // @mocco/common is private: the protocol schemas and constants are bundled in.
  noExternal: ['@mocco/common'],
  banner: { js: '#!/usr/bin/env node' },
});
