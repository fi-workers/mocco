// Test wiring for the auth boundary. Lives inside auth/ on purpose: production
// code must not import the provider, but tests need to bind it to pglite.
export { createProvider as createTestProvider, setProviderForTesting } from './provider';
export type { Provider } from './provider';
