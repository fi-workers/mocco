import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/openfeature-server.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2020',
  sourcemap: true,
  // Shared with the other SDKs and the app's own OpenFeature SDK, never bundled.
  external: ['@mocco/sdk-core', '@mocco/flags-core', '@openfeature/server-sdk', '@openfeature/core'],
});
