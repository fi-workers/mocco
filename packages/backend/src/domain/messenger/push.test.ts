import { describe, expect, it, vi } from 'vitest';

import { ExpoPushSender } from '@backend/domain/messenger/push';

const message = (index: number) => ({
  to: `ExponentPushToken[device-${index}]`,
  title: 'ShowYourTime',
  body: 'Fixed in 3.8.1',
  data: { mocco: 'messenger', conversationId: 'c1' },
});

describe('ExpoPushSender', () => {
  it('sends in batches of 100 with the access token, and marks devices that are gone', async () => {
    const batches: unknown[][] = [];
    const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as { to: string }[];
      batches.push(batch);
      return await Promise.resolve(
        Response.json({
          data: batch.map(entry =>
            entry.to.endsWith('[device-3]')
              ? { status: 'error', details: { error: 'DeviceNotRegistered' } }
              : { status: 'ok', id: 'ticket' },
          ),
        }),
      );
    });
    const sender = new ExpoPushSender({ accessToken: 'expo-token', fetch: fetchSpy });

    const results = await sender.send(Array.from({ length: 150 }, (_, index) => message(index)));

    expect(batches.map(batch => batch.length)).toEqual([100, 50]);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://exp.host/--/api/v2/push/send');
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer expo-token');
    expect(batches[0]?.[0]).toMatchObject({ sound: 'default', data: { conversationId: 'c1' } });
    expect(results.filter(result => !result.ok).map(result => [result.to, result.isDeviceGone])).toEqual([
      ['ExponentPushToken[device-3]', true],
    ]);
  });

  it('fails the job when Expo refuses the request (the runner retries it)', async () => {
    const sender = new ExpoPushSender({
      fetch: async () => await Promise.resolve(new Response('busy', { status: 503 })),
    });

    await expect(sender.send([message(1)])).rejects.toThrow(/503/u);
  });
});
