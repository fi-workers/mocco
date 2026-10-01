// Expo config plugin for @mocco/react-native: points expo-updates at a Mocco-hosted OTA
// app. In app.json: "plugins": [["@mocco/react-native", { "manifestUrl": "…", "channel": "production" }]].
// The same block `mocco-ota init` writes, kept in sync from config.
/** @param {Record<string, any>} config @param {{ manifestUrl?: string, channel?: string, codeSigningCertificate?: string, keyid?: string }} [props] */
function withMoccoOta(config, props = {}) {
  const {
    manifestUrl,
    channel = 'production',
    codeSigningCertificate = './certs/certificate.pem',
    keyid = 'root',
  } = props;
  if (typeof manifestUrl !== 'string' || !/\/ota\/apps\/[\da-f-]{36}\/manifest$/u.test(manifestUrl)) {
    throw new Error('@mocco/react-native: set "manifestUrl" to the manifest URL from Mocco (OTA hosting)');
  }
  const updates = config.updates ?? {};
  return {
    ...config,
    updates: {
      ...updates,
      url: manifestUrl,
      requestHeaders: { ...updates.requestHeaders, 'expo-channel-name': channel },
      codeSigningCertificate,
      codeSigningMetadata: { keyid, alg: 'rsa-v1_5-sha256' },
    },
  };
}

// Expo loads config plugins with require(), so this file is CommonJS.
// eslint-disable-next-line unicorn/prefer-module
module.exports = withMoccoOta;
