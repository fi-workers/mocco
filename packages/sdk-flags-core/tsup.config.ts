import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/flags-core.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2020',
  sourcemap: true,
});
