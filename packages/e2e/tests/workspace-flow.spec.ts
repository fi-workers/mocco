import { randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';

// Full session round-trip against the real server + Postgres: sign up →
// zero-workspace onboarding → create → switch active → sign out (session
// cleared, /workspaces gated) → sign back in (workspaces persist). This is the
// cookie/session path the pglite unit tests cannot exercise.
test('sign up, onboard, create + switch workspaces, sign out and back in', async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.com`;
  const password = 'e2e-password-123';

  // --- Sign up ---
  await page.goto('/auth/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();

  // --- First run: the account page shows its empty state (no workspace yet) ---
  await expect(page).toHaveURL(/\/workspaces$/);
  await expect(page.getByRole('heading', { name: 'Create your first workspace' })).toBeVisible();

  // --- Create the first workspace → the app appears, it's active ---
  await page.getByLabel('Workspace name').fill('Acme Lab');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  const acmeRow = page.locator('li', { hasText: 'Acme Lab' });
  await expect(acmeRow).toBeVisible();
  await expect(acmeRow.getByText('Active', { exact: true })).toBeVisible();

  // --- Create a second workspace (creation makes it active) ---
  await page.getByRole('button', { name: '+ New workspace' }).click();
  await page.getByLabel('Workspace name').fill('Beta Co');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  const betaRow = page.locator('li', { hasText: 'Beta Co' });
  await expect(betaRow.getByText('Active', { exact: true })).toBeVisible();

  // --- Switch active back to Acme ---
  await acmeRow.getByRole('button', { name: 'Switch' }).click();
  await expect(acmeRow.getByText('Active', { exact: true })).toBeVisible();

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
  await expect(page.locator('li', { hasText: 'Acme Lab' })).toBeVisible();
  await expect(page.locator('li', { hasText: 'Beta Co' })).toBeVisible();
});
