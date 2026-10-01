import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { isMandatoryUpdate, launchEventOf, otaStatusOf, postOtaEvents } from './ota-state';

const require = createRequire(import.meta.url);
const withMoccoOta = require('../app.plugin.js') as (
  config: Record<string, unknown>,
  props?: Record<string, string>,
) => { updates: Record<string, unknown> };

const idle = { isUpdateAvailable: false, isUpdatePending: false, isChecking: false, isDownloading: false };

describe('@mocco/react-native/ota', () => {
  it('maps expo-updates state to one status', () => {
    expect(otaStatusOf(idle)).toBe('idle');
    expect(otaStatusOf({ ...idle, isChecking: true })).toBe('checking');
    expect(otaStatusOf({ ...idle, isDownloading: true })).toBe('downloading');
    expect(otaStatusOf({ ...idle, isUpdatePending: true })).toBe('ready');
    expect(otaStatusOf({ ...idle, checkError: new Error('offline') })).toBe('error');
  });

  it('reads the mandatory flag Mocco puts in the manifest', () => {
    expect(isMandatoryUpdate({ extra: { mocco: { mandatory: true } } })).toBe(true);
    expect(isMandatoryUpdate({ extra: { mocco: { mandatory: false } } })).toBe(false);
    expect(isMandatoryUpdate(undefined)).toBe(false);
  });

  it('reports an emergency launch, and posts events in the shape the endpoint takes', async () => {
    const now = new Date('2026-10-02T00:00:00Z');
    const event = launchEventOf({ isEmergencyLaunch: true, updateId: 'u1' }, now);
    expect(event).toEqual({ type: 'emergency_launch', updateId: 'u1', occurredAt: now.toISOString() });

    const sent: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return await Promise.resolve(new Response(null, { status: 202 }));
    }) as unknown as typeof fetch;
    const isSent = await postOtaEvents(
      {
        apiBase: 'https://api.mocco.test/v1/',
        appId: 'app-1',
        clientId: 'device-1',
        platform: 'ios',
        fetch: fetchImpl,
      },
      [event],
    );

    expect(isSent).toBe(true);
    expect(sent).toEqual([
      {
        url: 'https://api.mocco.test/v1/ota/apps/app-1/events',
        body: { clientId: 'device-1', platform: 'ios', events: [event] },
      },
    ]);
  });

  it('config plugin writes the updates block for Mocco, and refuses a URL that is not Mocco', () => {
    const manifestUrl = 'https://api.mocco.club/v1/ota/apps/9a50b98d-4f33-41b3-973a-47f7b01c060d/manifest';

    const config = withMoccoOta(
      { name: 'Acme', updates: { checkAutomatically: 'ON_LOAD' } },
      { manifestUrl, channel: 'staging' },
    );

    expect(config.updates).toEqual({
      checkAutomatically: 'ON_LOAD',
      url: manifestUrl,
      requestHeaders: { 'expo-channel-name': 'staging' },
      codeSigningCertificate: './certs/certificate.pem',
      codeSigningMetadata: { keyid: 'root', alg: 'rsa-v1_5-sha256' },
    });
    expect(() => withMoccoOta({}, { manifestUrl: 'https://u.expo.dev/x' })).toThrow(/manifestUrl/u);
  });
});
