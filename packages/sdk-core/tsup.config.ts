import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/sdk-core.ts', 'src/status.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2020',
  sourcemap: true,
  // `status` imports the main entry by name, so both share one MoccoError.
  external: ['@mocco/sdk-core'],
});
