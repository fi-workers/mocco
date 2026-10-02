import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/mocco-node.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2020',
  sourcemap: true,
  // The SDKs share @mocco/sdk-core as a dependency, not a copy.
  external: ['@mocco/sdk-core'],
});
