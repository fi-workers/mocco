import { defineConfig } from 'vitest/config';

// Resolve @backend/* (tsconfig paths) natively — Vite 4 reads tsconfig paths
// without a plugin.
export default defineConfig({
  resolve: { tsconfigPaths: true },
});
