import { defineConfig } from 'vitest/config';

// Resolve @backend/* (tsconfig paths) natively — Vite 4 reads tsconfig paths
// without a plugin.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // Default backend include, plus the repo-root infra/local/scripts
    // loaders (with-env.ts etc.) — their tests import the script by
    // relative path, and this project's root already resolves up to the
    // repo root via `../..`, so picking it up here avoids a dedicated
    // vitest project just for two pure-fn test files.
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)', '../../infra/local/scripts/**/*.test.ts'],
    // pglite integration suites (the OTA ones sign and verify real releases, and the
    // rollout suite makes hundreds of update checks) outrun the 5 s default when the
    // whole suite runs in parallel.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
