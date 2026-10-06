// The public page's sign-up form (#156): it is plain HTML that posts without the script, the
// page renders whole with or without it, and with the script a failing endpoint (an error answer,
// a network failure, no fetch at all) only changes the form's message. The script runs in a VM
// with a minimal DOM: the browser itself is exercised by hand (docs/customer/status/subscribers.md).
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { pageScript, renderStatusPage } from '@backend/domain/status/snapshot/render';

import type { PublicSnapshot } from '@backend/domain/status/snapshot/format';

const component = (id: string, name: string) => ({
  id,
  name,
  description: null,
  status: 'operational' as const,
  uptime: { days: [], percent: null },
});

function snapshotWith(subscribe: PublicSnapshot['subscribe']): PublicSnapshot {
  return {
    format: 1,
    version: 3,
    builtAt: '2026-10-06T09:00:00.000Z',
    page: { slug: 'acme', title: 'Acme status' },
    status: 'operational',
    sections: [
      {
        name: null,
        components: [
          component('00000000-0000-4000-8000-000000000001', 'API'),
          component('00000000-0000-4000-8000-000000000002', 'Dashboard <beta>'),
        ],
      },
    ],
    incidents: [],
    maintenances: [],
    history: [],
    subscribe,
  };
}

const SUBSCRIBE_URL = 'https://mocco.test/api/ext/v1/status-pages/acme/subscribers';

describe('the sign-up form', () => {
  it('is a plain form that posts without the script, with a hidden honeypot', () => {
    const html = renderStatusPage(snapshotWith({ url: SUBSCRIBE_URL }), '');

    expect(html).toContain(`<form class="card subscribe" method="post" action="${SUBSCRIBE_URL}" data-subscribe>`);
    expect(html).toContain('<input id="subscribe-email" name="email" type="email" required');
    expect(html).toContain(
      '<div class="hp" aria-hidden="true"><label for="subscribe-website">Website</label><input id="subscribe-website" name="website" tabindex="-1" autocomplete="off"></div>',
    );
    expect(html).toContain('value="00000000-0000-4000-8000-000000000002"> Dashboard &lt;beta&gt;</label>');
    expect(html).toContain('<a href="#subscribe">Get updates</a>');
  });

  it('is left out where the deployment takes no sign-ups, and the page is the same otherwise', () => {
    const without = renderStatusPage(snapshotWith(null), '');
    const withForm = renderStatusPage(snapshotWith({ url: SUBSCRIBE_URL }), '');

    expect(without).not.toContain('data-subscribe>');
    expect(without).not.toContain('#subscribe');
    const parts = ['All systems operational', '<h2>Components</h2>', '<h2>Past incidents</h2>'];
    expect(parts.map(part => [without.includes(part), withForm.includes(part)])).toEqual([
      [true, true],
      [true, true],
      [true, true],
    ]);
  });
});

interface FakeElement {
  textContent: string;
  disabled: boolean;
  value: string;
}

/** Run the page's script against a minimal DOM; returns the submit handler and what it touched. */
function loadScript(globals: { fetch?: (url: string, init: unknown) => Promise<{ status: number }> }) {
  const listeners = new Map<string, (event: unknown) => void>();
  const status: FakeElement = { textContent: 'hint', disabled: false, value: '' };
  const button: FakeElement = { textContent: 'Subscribe', disabled: false, value: '' };
  const email: FakeElement = { textContent: '', disabled: false, value: '' };
  const posted: { url: string; init: unknown }[] = [];
  let resets = 0;
  const form = {
    action: SUBSCRIBE_URL,
    hasAttribute: (name: string) => name === 'data-subscribe',
    querySelector: (selector: string) => (selector === 'button' ? button : status),
    reset: () => {
      resets += 1;
    },
  };
  const document = {
    visibilityState: 'visible',
    activeElement: null,
    querySelectorAll: () => [],
    // eslint-disable-next-line sonarjs/null-dereference -- selector is a string
    querySelector: (selector: string) => (selector.includes('input[name=email]') ? email : null),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
  };
  // The page's own script, which the page runs in every visitor's browser.
  // eslint-disable-next-line sonarjs/code-eval
  runInNewContext(pageScript('', 3), {
    document,
    setInterval: () => 0,
    ...(globals.fetch !== undefined && {
      fetch: async (url: string, init: unknown) => {
        posted.push({ url, init });
        return await globals.fetch?.(url, init);
      },
      URLSearchParams: Object,
      FormData: Object,
    }),
  });
  /** Submit the form; whether the script took it over (prevented the plain post). */
  const submit = async () => {
    let isPrevented = false;
    listeners.get('submit')?.({
      target: form,
      preventDefault: () => {
        isPrevented = true;
      },
    });
    // Let the fetch chain settle.
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
    return isPrevented;
  };
  return { submit, status, button, posted, resets: () => resets, listeners };
}

describe("the page's script", () => {
  it('posts the form in the background and says it worked', async () => {
    const page = loadScript({ fetch: async () => await Promise.resolve({ status: 202 }) });

    expect(await page.submit()).toBe(true);
    expect(page.posted.map(post => post.url)).toEqual([SUBSCRIBE_URL]);
    expect(page.status.textContent).toBe('Check your inbox: we sent you a link to confirm your subscription.');
    expect(page.resets()).toBe(1);
    expect(page.button.disabled).toBe(false);
  });

  it('only changes the message when the endpoint refuses, fails or is unreachable', async () => {
    const refused = loadScript({ fetch: async () => await Promise.resolve({ status: 400 }) });
    const down = loadScript({ fetch: async () => await Promise.resolve({ status: 503 }) });
    const offline = loadScript({ fetch: async () => await Promise.reject(new TypeError('Failed to fetch')) });

    await refused.submit();
    await down.submit();
    await offline.submit();

    expect(refused.status.textContent).toBe('Check the address and try again.');
    expect(down.status.textContent).toBe("We couldn't sign you up right now. Try again later.");
    expect(offline.status.textContent).toBe("We couldn't sign you up right now. Try again later.");
    expect([refused, down, offline].map(page => [page.button.disabled, page.resets()])).toEqual([
      [false, 0],
      [false, 0],
      [false, 0],
    ]);
  });

  it('leaves the plain form post alone in a browser without fetch', async () => {
    const page = loadScript({});

    expect(await page.submit()).toBe(false);
    expect(page.status.textContent).toBe('hint');
  });
});
