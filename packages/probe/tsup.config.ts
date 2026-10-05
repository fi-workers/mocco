import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/create-agent.ts'],
  format: ['esm'],
  // The library entry a Mocco server embeds (STATUS_PROBE_EMBEDDED); the bin needs no types.
  dts: { entry: ['src/create-agent.ts'] },
  clean: true,
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  // @mocco/common is private: the protocol schemas and constants are bundled in.
  noExternal: ['@mocco/common'],
});
