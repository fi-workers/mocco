import { describe, expect, it } from 'vitest';

import { feedbackSiteForHost, feedbackSiteOrigin, helpSiteOrigin } from '@backend/domain/helpcenter/site-url';

const env = {
  SERVICE_DOMAIN: 'www.mocco.club',
  HELP_SITES_DOMAIN: 'help.mocco.club',
  HELP_CUSTOM_DOMAINS: 'help.syt.app=syt',
  HELP_APP_HOST_SITE: 'mocco',
};

describe('feedbackSiteOrigin', () => {
  it("serves HELP_APP_HOST_SITE's boards on the app's origin, and every other site on its own", () => {
    expect(feedbackSiteOrigin('mocco', env)).toBe('https://www.mocco.club');
    expect(feedbackSiteOrigin('syt', env)).toBe('https://help.syt.app');
    expect(feedbackSiteOrigin('acme', env)).toBe('https://acme.help.mocco.club');
    // The site's help center pages stay on its own host.
    expect(helpSiteOrigin('mocco', env)).toBe('https://mocco.help.mocco.club');
  });

  it('is the app origin even without any help host, and plain http locally', () => {
    expect(feedbackSiteOrigin('mocco', { SERVICE_DOMAIN: 'www.mocco.club', HELP_APP_HOST_SITE: 'mocco' })).toBe(
      'https://www.mocco.club',
    );
    expect(feedbackSiteOrigin('mocco', { SERVICE_DOMAIN: 'localhost:3326', HELP_APP_HOST_SITE: 'mocco' })).toBe(
      'http://localhost:3326',
    );
  });

  it('is unchanged without HELP_APP_HOST_SITE, or without SERVICE_DOMAIN to mount it on', () => {
    const today = { ...env, HELP_APP_HOST_SITE: undefined };
    expect(feedbackSiteOrigin('mocco', today)).toBe('https://mocco.help.mocco.club');
    expect(feedbackSiteOrigin('mocco', { HELP_APP_HOST_SITE: 'mocco' })).toBeNull();
    expect(feedbackSiteOrigin('mocco', { ...env, SERVICE_DOMAIN: undefined })).toBe('https://mocco.help.mocco.club');
  });
});

describe('feedbackSiteForHost', () => {
  it("maps the app's host to HELP_APP_HOST_SITE, and help hosts to their site", () => {
    expect(feedbackSiteForHost('www.mocco.club', env)).toBe('mocco');
    expect(feedbackSiteForHost('WWW.MOCCO.CLUB:443', env)).toBe('mocco');
    expect(feedbackSiteForHost('help.syt.app', env)).toBe('syt');
    expect(feedbackSiteForHost('mocco.help.mocco.club', env)).toBe('mocco');
    expect(feedbackSiteForHost('api.mocco.club', env)).toBeNull();
  });

  it("serves no site on the app's host without HELP_APP_HOST_SITE", () => {
    expect(feedbackSiteForHost('www.mocco.club', { ...env, HELP_APP_HOST_SITE: undefined })).toBeNull();
  });
});
