// The app's environments as an `as const` object (no TS enum) with a derived
// union type — plural const name, singular type name, keys matching their values.
// This module is only the vocabulary; reading the active value from env lives in
// Configure (lib/configure.ts), the checkable-style single config reader.
export const Environments = {
  Local: 'Local',
  Dev: 'Dev',
  Prod: 'Prod',
} as const;

export type Environment = (typeof Environments)[keyof typeof Environments];
