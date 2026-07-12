import { randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';

// Full session round-trip against the real server + Postgres, all client-rendered:
// sign up → zero-workspace onboarding → create (lands on its dashboard) → create
// a second via the switcher → switch between them → sign out (session cleared,
// /workspaces gated) → sign back in (/workspaces jumps into a workspace, both
// persist). This is the cookie/session path the pglite unit tests can't exercise.
test('sign up, create + switch workspaces via dashboards, sign out and back in', async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.com`;
  const password = 'e2e-password-123';
  const dashboardUrl = /\/workspaces\/[0-9a-f-]+$/;

  // --- Sign up ---
  await page.goto('/auth/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();

  // --- First run: the empty state prompts for the first workspace ---
  await expect(page).toHaveURL(/\/workspaces$/);
  await expect(page.getByRole('heading', { name: 'Create your first workspace' })).toBeVisible();

  // --- Create the first workspace → land on its dashboard ---
  await page.getByLabel('Workspace name').fill('Acme Lab');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(dashboardUrl);
  await expect(page.getByRole('link', { name: 'Members' })).toBeVisible(); // workspace left nav
  await expect(page.getByRole('heading', { name: 'No repositories yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Acme Lab' })).toBeVisible(); // switcher label

  // --- Create a second workspace via the switcher → its dashboard ---
  await page.getByRole('button', { name: 'Acme Lab' }).click();
  await page.getByRole('menuitem', { name: 'New workspace' }).click();
  await expect(page).toHaveURL(/\/workspaces\?create=1$/);
  await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible();
  await page.getByLabel('Workspace name').fill('Beta Co');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(dashboardUrl);
  await expect(page.getByRole('button', { name: 'Beta Co' })).toBeVisible(); // switcher label

  // --- Switch back to Acme through the switcher ---
  await page.getByRole('button', { name: 'Beta Co' }).click();
  await page.getByRole('menuitem', { name: 'Acme Lab' }).click();
  await expect(page).toHaveURL(dashboardUrl);
  await expect(page.getByRole('button', { name: 'Acme Lab' })).toBeVisible(); // switcher label

  // --- Rename via Settings; the switcher label follows ---
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]+\/settings$/);
  await page.getByLabel('Workspace name').fill('Acme Labs');
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByRole('button', { name: 'Acme Labs' })).toBeVisible();

  // --- Sign out (via the account menu): session cleared, /workspaces is gated ---
  await page.getByRole('button', { name: 'Open account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/workspaces');
  await expect(page).toHaveURL(/\/auth\/sign-in$/); // client guard redirects — no session

  // --- Sign back in: /workspaces jumps straight into a workspace; both persist ---
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(dashboardUrl);
  await page.getByRole('button', { name: /Acme Labs|Beta Co/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Acme Labs' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Beta Co' })).toBeVisible();
});
