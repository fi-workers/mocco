// `mocco-ota init`: make the code-signing key pair and the self-signed certificate the
// app embeds, and point app.json at Mocco (OTA design §2). The private key stays local
// (store it as a CI secret); the certificate is registered in the console.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  convertCertificateToCertificatePEM,
  convertKeyPairToPEM,
  generateKeyPair,
  generateSelfSignedCodeSigningCertificate,
} from '@expo/code-signing-certificates';
import { SIGNING_ALGORITHM } from '@mocco/common/ota-hosting';

import { parseManifestUrl, readAppJson, writeAppJson } from './app-config';
import { CliError } from './errors';
import { isPresent } from './fs';

export interface InitOptions {
  projectDir: string;
  manifestUrl: string;
  channel: string;
  keyid: string;
  /** Years the certificate is valid; a new one needs a new binary. */
  validityYears?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

export const KEY_FILE = 'keys/private-key.pem';
export const PUBLIC_KEY_FILE = 'keys/public-key.pem';
export const CERTIFICATE_FILE = 'certs/certificate.pem';

/** Make sure `keys/` is git-ignored: the private key must never be committed. */
async function ignoreKeys(projectDir: string): Promise<void> {
  const file = path.join(projectDir, '.gitignore');
  const current = (await isPresent(file)) ? await readFile(file, 'utf8') : '';
  // eslint-disable-next-line sonarjs/null-dereference -- current and each line are strings, never null
  if (current.split('\n').every(line => line.trim() !== 'keys/')) {
    await writeFile(file, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}keys/\n`);
  }
}

export async function init(options: InitOptions): Promise<{ appId: string; certificateFile: string }> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const { appId } = parseManifestUrl(options.manifestUrl);
  const { file, json } = await readAppJson(options.projectDir);
  const keyFile = path.join(options.projectDir, KEY_FILE);
  if (await isPresent(keyFile)) {
    throw new CliError(`${KEY_FILE} already exists; delete it first to make a new key (it needs a new binary)`);
  }

  const keyPair = generateKeyPair();
  const notBefore = now();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + (options.validityYears ?? 10));
  const certificate = generateSelfSignedCodeSigningCertificate({
    keyPair,
    validityNotBefore: notBefore,
    validityNotAfter: notAfter,
    commonName: `Mocco OTA ${appId}`,
  });
  const pems = convertKeyPairToPEM(keyPair);
  await mkdir(path.join(options.projectDir, 'keys'), { recursive: true });
  await mkdir(path.join(options.projectDir, 'certs'), { recursive: true });
  await writeFile(keyFile, pems.privateKeyPEM, { mode: 0o600 });
  await writeFile(path.join(options.projectDir, PUBLIC_KEY_FILE), pems.publicKeyPEM);
  const certificateFile = path.join(options.projectDir, CERTIFICATE_FILE);
  await writeFile(certificateFile, convertCertificateToCertificatePEM(certificate));
  await ignoreKeys(options.projectDir);

  const expo = json.expo ?? {};
  await writeAppJson(file, {
    ...json,
    expo: {
      ...expo,
      updates: {
        ...expo.updates,
        url: options.manifestUrl,
        requestHeaders: { 'expo-channel-name': options.channel },
        codeSigningCertificate: `./${CERTIFICATE_FILE}`,
        codeSigningMetadata: { keyid: options.keyid, alg: SIGNING_ALGORITHM },
      },
    },
  });
  log(`Wrote ${CERTIFICATE_FILE}, ${KEY_FILE} (git-ignored) and the updates block in app.json.`);
  log(`Next: register ${CERTIFICATE_FILE} in Mocco (OTA hosting → Signing certificates, keyid "${options.keyid}"),`);
  log(`and store ${KEY_FILE} as the CI secret MOCCO_OTA_SIGNING_KEY.`);
  return { appId, certificateFile };
}
