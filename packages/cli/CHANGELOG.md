# @mocco/cli

> Renamed from `@mocco/ota-cli` before its first publish; the entries below predate the rename.

## 0.2.0

### Minor Changes

- 824dd0f: `publish` resolves the `fingerprint` runtime version per platform with the project's own `expo-updates fingerprint:generate`, instead of refusing the policy and asking for `--runtime-version`. iOS and Android hash differently, so they become separate releases — one shared value would leave a platform's devices never matching an update. The export also names the platforms it was asked for, so a project that targets web no longer bundles web (and no longer fails the publish on a web-only bundling error).

  `init --keep-key` rewrites only the `updates` block, keeping the key pair and certificate already in the project — for pointing an app at another Mocco app without the new store build a new key would need.

### Patch Changes

- e4b5087: Internal: the `runtimeVersion` policies are a named constant instead of bare strings, `init` types the Expo config it rewrites instead of asserting it, and the `expo export` and `fingerprint:generate` command lines and the fingerprint parsing are pure functions, so the two bugs they were introduced to fix are covered by tests rather than by one manual run.
- Updated dependencies [7e7c786]
  - @mocco/sdk-core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [cd49729]
  - @mocco/sdk-core@0.2.0

## 0.1.0

### Minor Changes

- 5a8f153: First release of Mocco's SDKs: the shared /v1 client (`@mocco/sdk-core`), the browser SDK (`@mocco/js`), the server SDK with `signIdentity()` and `verifyWebhook()` (`@mocco/node`), the React Native SDK with hosted OTA updates and its Expo config plugin (`@mocco/react-native`), and the `mocco-ota` CLI (`@mocco/ota-cli`).

### Patch Changes

- Updated dependencies [9cd21f2]
- Updated dependencies [8201753]
- Updated dependencies [19bb610]
- Updated dependencies [5a8f153]
- Updated dependencies [8ad5fb9]
- Updated dependencies [a018af6]
- Updated dependencies [914ddb2]
- Updated dependencies [b99b71b]
- Updated dependencies [bc9caf8]
  - @mocco/sdk-core@0.1.0
