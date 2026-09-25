// Production composition root for SecretBox. Lazy: importing never reads env, and a
// deploy without SECRETS_ENCRYPTION_KEYS boots fine — only a feature that seals or
// opens a secret fails, with a message naming the env var.
import { getEnv } from '@backend/infra/config/env';
import { SecretBoxError } from '@backend/infra/crypto/errors';
import { SecretBox, parseSecretKeys } from '@backend/infra/crypto/secret-box';

export function createSecretBox(raw: string | undefined): SecretBox {
  if (raw === undefined) {
    throw new SecretBoxError('SECRETS_ENCRYPTION_KEYS is not set — required to store third-party secrets');
  }
  return new SecretBox(parseSecretKeys(raw));
}

const state: { box?: SecretBox } = {};

export function getSecretBox(): SecretBox {
  state.box ??= createSecretBox(getEnv().SECRETS_ENCRYPTION_KEYS);
  return state.box;
}
