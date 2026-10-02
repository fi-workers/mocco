---
'@mocco/sdk-core': minor
'@mocco/react-native': minor
---

In-app contact with Mocco Messenger. `@mocco/sdk-core` gains `MessengerClient`, a headless client for a signed-in user's conversations with your team. `@mocco/react-native/messenger` adds `createMessenger`, `<MessengerProvider>` and the hooks `useConversations`, `useConversation`, `useUnreadCount` and `useMessengerCategories`, so your app draws the screens in its own design. `expo-updates` is now an optional peer: only `@mocco/react-native/ota` needs it.
