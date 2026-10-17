// The port the e2e server listens on: 3100, or E2E_PORT when a dev server already holds it.
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_ORIGIN = `http://localhost:${String(E2E_PORT)}`;
