# @mocco/react-native

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
