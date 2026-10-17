# @mocco/react-native

## 0.4.0

### Minor Changes

- 3f4d603: `HelpClient.sendFeedback(id, { helpful, locale?, comment? })` answers "Was this helpful?" for a published article. Pass a `visitorId` the app keeps (such as an install id) to `createHelp` so Mocco counts one answer per reader, article and day; without one the client makes a random id for its own lifetime. Mocco stores only a hash of it.
- b010c94: `HelpClient` reads a project's published help center as well as searching it: `getSite` (name, languages and the collections → sections → articles), `getCollection(slug)` and `getArticle(id)`, each in the reader's language where translated, with `locale` on the answer saying which was served. `getArticle` and `getCollection` answer `null` for what isn't published. `@mocco/js` exports `createHelp` and `HelpClient`; `@mocco/react-native/messenger` exports the new types.
- a358655: Messenger attachments can be PDFs: `MessengerClient.attach` takes `contentType: 'application/pdf'` (up to 10 MB, like screenshots), and every served attachment carries its `filename`. A PDF's `url` is a download link, never one to open in a browser tab. The bytes must be the declared type, or the message that carries them is refused.

### Patch Changes

- Updated dependencies [3f4d603]
- Updated dependencies [b010c94]
- Updated dependencies [a358655]
- Updated dependencies [29a7b09]
- Updated dependencies [1b64c71]
- Updated dependencies [b967209]
  - @mocco/sdk-core@0.4.0

## 0.3.0

### Minor Changes

- 7e7c786: Help center search for apps: `HelpClient.search(query, { locale, limit })` returns the project's published help articles (with `title`, `url` and a `snippet`), for a key with the new `help:read` scope. In React Native, `createHelp` and `useHelpSearch(help, query)` (from `@mocco/react-native/messenger`) search as the user types, for example to suggest articles on a contact screen. `match: 'any'` finds articles sharing any word with free text, such as an inquiry being written.

### Patch Changes

- Updated dependencies [7e7c786]
  - @mocco/sdk-core@0.3.0

## 0.2.0

### Minor Changes

- cd49729: `MessengerClient.deleteMyData()`: erase everything the user wrote (conversations, messages, screenshots) in Mocco and forget them on the device, for an app's "delete my account".

### Patch Changes

- Updated dependencies [cd49729]
  - @mocco/sdk-core@0.2.0

## 0.1.0

### Minor Changes

- 5a8f153: First release of Mocco's SDKs: the shared /v1 client (`@mocco/sdk-core`), the browser SDK (`@mocco/js`), the server SDK with `signIdentity()` and `verifyWebhook()` (`@mocco/node`), the React Native SDK with hosted OTA updates and its Expo config plugin (`@mocco/react-native`), and the `mocco-ota` CLI (`@mocco/ota-cli`).
- 8ad5fb9: Messenger attachments: `MessengerClient.attach()` uploads a screenshot and returns its id for `startConversation` / `sendMessage` (and `useConversation().send(body, attachmentIds)`); messages carry `attachments` with short-lived download links.
- a018af6: Messenger guests: `MessengerClient.continueAsGuest({ email, name? })` lets someone who isn't signed in write (when the app allows guests). The device keeps the guest, and signing in later moves what they wrote to their account. `MessengerState.isGuest` tells which you have.
- 914ddb2: Messenger reply push: `MessengerClient.registerPushToken()` registers the device's Expo push token (removed again on `signOut()`), and `messengerConversationIdOf(data)` reads the conversation a notification is about.
- b99b71b: `MessengerClient.reidentify()`: call it when someone signs in to the app. The messenger asks `identity` again and opens their session; what the device wrote as a guest moves to the account, and a registered push token follows. `@mocco/react-native/messenger` also exports `MoccoError` and `MoccoNetworkError`, so an app can tell a refusal (such as `guests_not_allowed`) from a network failure. The stored session is kept per publishable key, so a build with another key (another project) doesn't reuse it.
- bc9caf8: In-app contact with Mocco Messenger. `@mocco/sdk-core` gains `MessengerClient`, a headless client for a signed-in user's conversations with your team. `@mocco/react-native/messenger` adds `createMessenger`, `<MessengerProvider>` and the hooks `useConversations`, `useConversation`, `useUnreadCount` and `useMessengerCategories`, so your app draws the screens in its own design. `expo-updates` is now an optional peer: only `@mocco/react-native/ota` needs it.

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
