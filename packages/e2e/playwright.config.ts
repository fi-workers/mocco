import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

// e2e runs against the real Next server + a real Postgres (the app uses
// node-postgres, not the pglite that vitest uses). The suite exercises the
// session cookie round-trip that unit tests can't reach.
export default defineConfig({
  testDir: './tests',
  // Shared Postgres — serialize so one test's data never races another's.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'line',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Build (env-free, lazy env) then start the production server on PORT.
    command: 'yarn workspace @mocco/frontend build && yarn workspace @mocco/frontend exec next start -p 3100',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://mocco:mocco@localhost:5432/mocco',
      AUTH_SECRET: process.env.AUTH_SECRET ?? 'e2e-ephemeral-secret-not-for-prod',
      AUTH_URL: baseURL,
    },
  },
});
