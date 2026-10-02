import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/openfeature-web.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2020',
  sourcemap: true,
  // Shared with the other SDKs and the app's own OpenFeature SDK, never bundled.
  external: ['@mocco/sdk-core', '@openfeature/ofrep-web-provider', '@openfeature/web-sdk', '@openfeature/core'],
});
