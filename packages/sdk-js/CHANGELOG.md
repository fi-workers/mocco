# @mocco/js

## 0.2.0

### Minor Changes

- 3f4d603: `HelpClient.sendFeedback(id, { helpful, locale?, comment? })` answers "Was this helpful?" for a published article. Pass a `visitorId` the app keeps (such as an install id) to `createHelp` so Mocco counts one answer per reader, article and day; without one the client makes a random id for its own lifetime. Mocco stores only a hash of it.
- b010c94: `HelpClient` reads a project's published help center as well as searching it: `getSite` (name, languages and the collections → sections → articles), `getCollection(slug)` and `getArticle(id)`, each in the reader's language where translated, with `locale` on the answer saying which was served. `getArticle` and `getCollection` answer `null` for what isn't published. `@mocco/js` exports `createHelp` and `HelpClient`; `@mocco/react-native/messenger` exports the new types.

### Patch Changes

- Updated dependencies [3f4d603]
- Updated dependencies [b010c94]
- Updated dependencies [a358655]
- Updated dependencies [29a7b09]
- Updated dependencies [1b64c71]
- Updated dependencies [b967209]
  - @mocco/sdk-core@0.4.0

## 0.1.2

### Patch Changes

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
