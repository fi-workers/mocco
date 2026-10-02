# @mocco/openfeature-web

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

- 41c397b: Feature flags for browsers and apps. `@mocco/openfeature-web` (`MoccoWebProvider`) is OpenFeature's OFREP web provider with Mocco's defaults: Mocco evaluates, so rules never reach the browser, and the provider follows Mocco's change stream. `@mocco/openfeature-react-native` (`MoccoReactNativeProvider`) keeps the last answers in AsyncStorage (served at launch and offline), refreshes when the app returns to the foreground, and follows the change stream through `react-native-sse`. Both take a publishable key with `flags:read`.
- 19bb610: The flag providers send Mocco how often each flag was read, counted in memory and sent at most once a minute (`telemetry: false` turns it off). Mocco uses the counts only to point out flags that look ready to remove. `@mocco/sdk-core` gains `EvaluationCounter`.

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
