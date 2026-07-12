import { randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';

// Slice 1 is preview-only: a signed-in user pastes a `.mocco.yml` and sees it
// parsed (or the parse issues). Nothing is persisted.
test('preview a valid .mocco.yml, and see inline issues on an invalid one', async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.com`;
  const password = 'e2e-password-123';

  // Sign up → the account page's empty state: a fresh user creates a workspace
  // before the rest of the app (the shell) will let them in.
  await page.goto('/auth/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
  await page.getByLabel('Workspace name').fill('E2E Workspace');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.locator('li', { hasText: 'E2E Workspace' })).toBeVisible();

  // Valid config → the parsed pipeline + step labels render.
  await page.goto('/pipelines/new');
  await page
    .getByLabel('mocco.yml')
    .fill(
      'version: 1\npipeline: deploy\nsteps:\n  - run: build\n    executor: generic\n  - run: ship\n    executor: generic',
    );
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('heading', { name: 'deploy' })).toBeVisible();
  await expect(page.getByText('build', { exact: true })).toBeVisible();
  await expect(page.getByText('ship', { exact: true })).toBeVisible();

  // Invalid config → the specific parse issue surfaces inline.
  await page.getByLabel('mocco.yml').fill('version: 1\npipeline: p\nsteps: []');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText(/steps/)).toBeVisible();
});
