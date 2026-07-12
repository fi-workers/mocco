import { randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';

const validYaml =
  'version: 1\npipeline: deploy\nsteps:\n  - run: build\n    executor: generic\n  - run: ship\n    executor: generic\n';
const invalidYaml = 'version: 1\npipeline: x\nsteps: []';

// Defining a pipeline requires a signed-in user with an active workspace — both
// gated server-side (getServerSideProps redirect / PRECONDITION_FAILED on
// submit) — so this repeats the workspace-flow signup + create-workspace steps
// verbatim before exercising the pipeline define/view UI.
test('define a pipeline from .mocco.yml, view it, and see inline errors on an invalid one', async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.com`;
  const password = 'e2e-password-123';

  // --- Sign up ---
  await page.goto('/');
  await page.getByRole('button', { name: 'No account? Create one' }).click();
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();

  // --- Onboarding: create the workspace a pipeline submit requires ---
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { name: 'Create your first workspace' })).toBeVisible();
  await page.getByLabel('Workspace name').fill('Acme Lab');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.locator('li', { hasText: 'Acme Lab' }).getByText('Active', { exact: true })).toBeVisible();

  // --- Define a pipeline from a valid .mocco.yml ---
  await page.goto('/pipelines/new');
  await page.getByLabel('mocco.yml').fill(validYaml);
  await page.getByRole('button', { name: 'Submit pipeline' }).click();

  // --- Redirects to the new pipeline's page, showing its name + ordered steps ---
  await expect(page).toHaveURL(/\/pipelines\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'deploy' })).toBeVisible();
  await expect(page.getByText('build', { exact: true })).toBeVisible();
  await expect(page.getByText('ship', { exact: true })).toBeVisible();

  // --- Shows up in the pipeline list ---
  await page.goto('/pipelines');
  await expect(page.locator('li', { hasText: 'deploy' })).toBeVisible();

  // --- Submitting an invalid config shows the error inline — no redirect ---
  await page.goto('/pipelines/new');
  await page.getByLabel('mocco.yml').fill(invalidYaml);
  await page.getByRole('button', { name: 'Submit pipeline' }).click();
  // the specific parse issue surfaces inline (path-prefixed), not a generic string
  await expect(page.getByText(/steps/)).toBeVisible();
  await expect(page).toHaveURL(/\/pipelines\/new$/);
});
