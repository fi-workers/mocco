/** A SecretBox failure: bad configuration, a malformed or tampered sealed value, or a
 * value sealed with a key that is no longer configured. Messages never carry
 * plaintext, key material or the sealed string. */
export class SecretBoxError extends Error {}
