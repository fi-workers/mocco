import { createHmac, randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';

import type { Page } from '@playwright/test';

// The feedback product end to end against the real server and Postgres (#175, #176): a team turns
// it on and opens a board; an app's signed-in users post and vote on the public board; the team
// triages in the console (official response, internal note, status) and announces what shipped in
// the changelog. Public pages are ISR-cached for a minute under `next start`, so live data is read
// through the site's own routes (what the pages' browser code calls) and each page is opened for
// the first time only once its data exists.

// eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Uint8Array#toBase64 isn't in Node 24
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An HS256 end-user token, as a customer's server signs one with the project's identity secret. */
function endUserToken(secret: string, sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'HS256' })}.${encode({ sub, iat: now, exp: now + 15 * 60 })}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

/** The project's public help site, served at <site>.help.localhost:<port> (HELP_SITES_DOMAIN). */
const siteOrigin = (page: Page, site: string) => {
  const url = new URL(page.url());
  return `${url.protocol}//${site}.help.localhost:${url.port}`;
};

test('a board from setup to a shipped, announced idea', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const handle = `fb${randomUUID().slice(0, 8)}`;

  // --- The team: account, workspace, project, products ---
  await page.goto('/auth/sign-up');
  await page.getByLabel('Name').fill('Grace Hopper');
  await page.getByLabel('Email').fill(`e2e-feedback-${randomUUID()}@example.com`);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Workspace name').fill('Hopper Labs');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]+\/home$/);
  const workspaceUrl = page.url().replace(/\/home$/, '');

  await page.goto(`${workspaceUrl}/projects`);
  await page.getByLabel('Name').fill('Timekeeper');
  await page.getByLabel('Handle').fill(handle);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]+$/); // the new project's overview
  const projectUrl = page.url();

  await page.goto(`${workspaceUrl}/products`);
  const turnOn = async (product: string) => {
    // The card that starts with the product's label: descriptions mention other products.
    const card = page.getByRole('listitem').filter({ hasText: new RegExp(`^${product}`, 'u') });
    await card.getByRole('button', { name: 'Turn on' }).click();
    await expect(card.getByRole('button', { name: 'Turn off' })).toBeVisible();
  };
  await turnOn('Help center');
  await turnOn('Messenger');
  await turnOn('Feedback board');

  // Help center (the board's public host), messenger (the identity secret users' tokens are signed with).
  await page.goto(`${projectUrl}/help`);
  await page.getByLabel('Address').fill(handle);
  await page.getByRole('button', { name: 'Set up help center' }).click();
  await expect(page.getByLabel('New collection')).toBeVisible();
  await page.goto(`${projectUrl}/inbox`);
  await page.getByRole('button', { name: 'Set up messenger' }).click();
  await expect(page.getByText('Messenger is set up')).toBeVisible();
  const secret = await page.getByLabel('Identity secret').inputValue();
  expect(secret).not.toBe('');

  // --- The first board ---
  await page.goto(`${projectUrl}/feedback`);
  await expect(page.getByRole('heading', { name: 'Create your first board' })).toBeVisible();
  await page.getByLabel('Name').fill('Feature requests');
  await page.getByRole('button', { name: 'Create board' }).click();
  await expect(page).toHaveURL(/board=feature-requests/);

  // --- An app's signed-in users on the public board ---
  const site = handle;
  const origin = siteOrigin(page, site);
  const ada = await browser.newPage();
  await ada.goto(`${origin}/feedback/feature-requests?token=${endUserToken(secret, 'user-ada')}`);
  await expect(ada).toHaveURL(`${origin}/feedback/feature-requests`); // the token leaves the address
  await ada.getByLabel('Title').fill('Dark mode for the timer screen');
  await ada.getByLabel('Details').fill('The timer is too bright at night.');
  await ada.getByRole('button', { name: 'Post' }).click();
  await expect(ada).toHaveURL(`${origin}/feedback/feature-requests/1`);

  // From the board's own page, as its browser code calls them: Chromium resolves *.localhost itself.
  const siteCall = async (path: string, init: { method?: string; token?: string } = {}) =>
    await ada.evaluate(
      async ({ url, method, token }) => {
        const answer = await fetch(url, {
          method,
          headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        });
        return { status: answer.status, text: await answer.text() };
      },
      { url: `/api/ext/sites/${site}/feedback${path}`, method: init.method ?? 'GET', token: init.token },
    );
  const posts = async () => {
    const answer = await siteCall('/boards/feature-requests/posts?sort=top');
    expect(answer.status).toBe(200);
    return (JSON.parse(answer.text) as { posts: { id: string; number: number; voteCount: number; status: string }[] })
      .posts;
  };
  const [post] = await posts();
  expect(post).toMatchObject({ number: 1, voteCount: 1, status: 'under_review' });
  const postId = post?.id ?? '';

  // Another signed-in user votes; the count is live.
  const vote = await siteCall(`/posts/${postId}/vote`, { method: 'POST', token: endUserToken(secret, 'user-bob') });
  expect(vote.status).toBe(200);
  const [voted] = await posts();
  expect(voted?.voteCount).toBe(2);

  // --- Triage in the console ---
  await page.goto(`${projectUrl}/feedback`);
  await page.getByRole('link', { name: 'Dark mode for the timer screen' }).click();
  await expect(page).toHaveURL(/\/feedback\/posts\//);
  await page.getByLabel('Comment text').fill('Big customers asked for this; aim for the next release.');
  await page.getByLabel('Internal note').check();
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Big customers asked for this')).toBeVisible();
  // The form resets once the note is saved (a refetch can show the note a moment earlier).
  await expect(page.getByLabel('Comment text')).toHaveValue('');
  await expect(page.getByRole('radio', { name: 'Reply' })).toBeChecked();
  await page.getByLabel('Comment text').fill('Thanks! This is planned for the next release.');
  await page.getByLabel('Official response').check();
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByText('Thanks! This is planned')).toBeVisible();
  await page.getByLabel('Status').selectOption('planned');
  await expect(page.getByLabel('Status')).toHaveValue('planned');

  // The public comments carry the official response and never the internal note.
  const { text: publicText } = await siteCall(`/posts/${postId}/comments`);
  expect(publicText).toContain('Thanks! This is planned');
  expect(publicText).not.toContain('Big customers');
  const [planned] = await posts();
  expect(planned?.status).toBe('planned');

  // --- Ship it and announce it in the changelog ---
  await page.getByLabel('Status').selectOption('shipped');
  await expect(page.getByLabel('Status')).toHaveValue('shipped');
  await page.goto(`${projectUrl}/feedback/changelog`);
  await page.getByLabel('Title of the new entry').fill('Dark mode is here');
  await page.getByRole('button', { name: 'New entry' }).click();
  await expect(page).toHaveURL(/\/feedback\/changelog\/[0-9a-f-]+$/);
  await page.getByLabel('Text (Markdown)').fill('Turn it on in **Settings**.');
  await page.getByLabel('New', { exact: true }).check();
  await page.getByLabel('Find a post to add').fill('dark');
  await page.getByRole('button', { name: /Dark mode for the timer screen/ }).click();
  await page.getByRole('button', { name: 'Publish now' }).click();
  await expect(page.getByRole('button', { name: 'Unpublish' })).toBeVisible();

  // The public changelog (opened for the first time now) shows the entry and the idea it shipped.
  await ada.goto(`${origin}/feedback/feature-requests/changelog`);
  await expect(ada.getByRole('heading', { name: 'Dark mode is here' })).toBeVisible();
  await expect(ada.getByRole('link', { name: '#1 Dark mode for the timer screen' })).toBeVisible();
  const feed = await ada.evaluate(async () => {
    const answer = await fetch('/feedback/feature-requests/changelog.rss');
    return { type: answer.headers.get('content-type') ?? '', text: await answer.text() };
  });
  expect(feed.type).toContain('application/rss+xml');
  expect(feed.text).toContain('<title>Dark mode is here</title>');
});
