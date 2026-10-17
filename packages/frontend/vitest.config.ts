// Unit tests for the frontend's pure modules (src/lib). Components are checked in the browser
// (agent-browser) and by the e2e suite; these run in Node with the same path aliases as the app.
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@frontend': fileURLToPath(new URL('src', import.meta.url)),
      '@backend': fileURLToPath(new URL('../backend/src', import.meta.url)),
    },
  },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
