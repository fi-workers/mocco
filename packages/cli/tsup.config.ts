import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/publish.ts', 'src/init.ts', 'src/promote.ts'],
  format: ['esm'],
  dts: { entry: ['src/publish.ts', 'src/init.ts', 'src/promote.ts'] },
  clean: true,
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  // @mocco/common is private: its schemas and constants are bundled in.
  noExternal: ['@mocco/common'],
  external: ['@mocco/sdk-core'],
  banner: ({ format }) => (format === 'esm' ? { js: '#!/usr/bin/env node' } : {}),
});
