import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/sdk-core.ts', 'src/status.ts', 'src/feedback.ts', 'src/whats-new.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2020',
  sourcemap: true,
  // The subpaths import the main entry (and each other) by name, so all share one MoccoError.
  external: ['@mocco/sdk-core'],
});
