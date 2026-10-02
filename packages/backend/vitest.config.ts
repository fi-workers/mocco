import { defineConfig } from 'vitest/config';

// Resolve @backend/* (tsconfig paths) natively — Vite 4 reads tsconfig paths
// without a plugin. The SDK packages resolve to their sources (the "@mocco/source"
// export condition), so the end-to-end SDK tests run without building them first.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Vite's default server conditions follow, without "module": it picks packages' untranspiled ESM builds.
  ssr: { resolve: { conditions: ['@mocco/source', 'node', 'development|production'] } },
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
