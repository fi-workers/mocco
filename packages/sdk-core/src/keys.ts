import { MoccoKeyError } from './errors';

/** Publishable keys ship in apps; secret keys stay on servers and CI. */
export type KeyKind = 'publishable' | 'secret';

const PREFIXES: Record<KeyKind, string> = { publishable: 'mk_pub_', secret: 'mk_sec_' };

/** The kind of a Mocco API key, or null when it isn't one. */
export function keyKindOf(key: string): KeyKind | null {
  // eslint-disable-next-line sonarjs/null-dereference -- key is a string, never null
  if (key.startsWith(PREFIXES.publishable)) {
    return 'publishable';
  }
  return key.startsWith(PREFIXES.secret) ? 'secret' : null;
}

/** Refuse a key that can't work here: Mocco rejects secret keys sent from a browser. */
export function checkKey(key: string, where: { isBrowser: boolean }): KeyKind {
  const kind = keyKindOf(key);
  if (kind === null) {
    throw new MoccoKeyError('That is not a Mocco API key (mk_pub_… or mk_sec_…)');
  }
  if (kind === 'secret' && where.isBrowser) {
    throw new MoccoKeyError('Secret keys must not be used in a browser; use a publishable key (mk_pub_…)');
  }
  return kind;
}
