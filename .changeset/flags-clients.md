---
'@mocco/openfeature-web': minor
'@mocco/openfeature-react-native': minor
---

Feature flags for browsers and apps. `@mocco/openfeature-web` (`MoccoWebProvider`) is OpenFeature's OFREP web provider with Mocco's defaults: Mocco evaluates, so rules never reach the browser, and the provider follows Mocco's change stream. `@mocco/openfeature-react-native` (`MoccoReactNativeProvider`) keeps the last answers in AsyncStorage (served at launch and offline), refreshes when the app returns to the foreground, and follows the change stream through `react-native-sse`. Both take a publishable key with `flags:read`.
