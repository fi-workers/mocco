import { defineConfig } from 'vitest/config';

// Workspace imports of the SDK packages resolve to their sources (the "@mocco/source"
// export condition), so tests don't need a build first.
export default defineConfig({
  resolve: { conditions: ['@mocco/source', 'import', 'default'] },
  ssr: { resolve: { conditions: ['@mocco/source', 'import', 'default'] } },
});
