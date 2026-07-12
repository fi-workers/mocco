import { randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';

// Full session round-trip against the real server + Postgres: sign up →
// zero-workspace onboarding → create (lands on its dashboard) → create a second
// → switch between them via the top-bar switcher → sign out (session cleared,
// /workspaces gated) → sign back in (both workspaces persist). This is the
// cookie/session path the pglite unit tests cannot exercise.
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

  // --- Create the first workspace → land on its dashboard, it's active ---
  await page.getByLabel('Workspace name').fill('Acme Lab');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(dashboardUrl);
  await expect(page.getByRole('heading', { name: 'Acme Lab' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No repositories yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Acme Lab' })).toBeVisible(); // switcher label

  // --- Create a second workspace via the switcher → its dashboard ---
  await page.getByRole('button', { name: 'Acme Lab' }).click();
  await page.getByRole('menuitem', { name: 'Manage workspaces' }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
  await page.getByRole('button', { name: '+ New workspace' }).click();
  await page.getByLabel('Workspace name').fill('Beta Co');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(dashboardUrl);
  await expect(page.getByRole('heading', { name: 'Beta Co' })).toBeVisible();

  // --- Switch back to Acme through the switcher ---
  await page.getByRole('button', { name: 'Beta Co' }).click();
  await page.getByRole('menuitem', { name: 'Acme Lab' }).click();
  await expect(page).toHaveURL(dashboardUrl);
  await expect(page.getByRole('heading', { name: 'Acme Lab' })).toBeVisible();

  // --- Sign out (via the account menu): session cleared, /workspaces is gated ---
  await page.getByRole('button', { name: 'Open account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/workspaces');
  await expect(page).toHaveURL(/\/auth\/sign-in$/); // getServerSideProps redirects — no session

  // --- Sign back in: both workspaces persisted ---
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
  await expect(page.getByRole('link', { name: /Acme Lab/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Beta Co/ })).toBeVisible();
});
