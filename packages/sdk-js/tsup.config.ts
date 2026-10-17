import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/mocco-js.ts', 'src/feedback.ts', 'src/whats-new.ts', 'src/feedback-sheet.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2020',
  sourcemap: true,
  // The SDKs share @mocco/sdk-core as a dependency, not a copy.
  external: ['@mocco/sdk-core'],
});
