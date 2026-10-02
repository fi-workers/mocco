---
'@mocco/sdk-core': minor
'@mocco/react-native': minor
---

`MessengerClient.reidentify()`: call it when someone signs in to the app. The messenger asks `identity` again and opens their session; what the device wrote as a guest moves to the account, and a registered push token follows. `@mocco/react-native/messenger` also exports `MoccoError` and `MoccoNetworkError`, so an app can tell a refusal (such as `guests_not_allowed`) from a network failure. The stored session is kept per publishable key, so a build with another key (another project) doesn't reuse it.
