# @mocco/openfeature-server

## 0.1.3

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

- 9cd21f2: Feature flags for servers: `@mocco/flags-core` evaluates Mocco's flagd-compatible rulesets locally (the restricted JsonLogic subset, `fractional` bucketing, `sem_ver`), and `@mocco/openfeature-server` is an OpenFeature server provider that polls the key's ruleset with ETags and keeps serving the last good one when Mocco is unreachable. `MoccoClient.getIfChanged()` adds conditional GETs.
- 8201753: `@mocco/openfeature-server` listens to Mocco's change stream and fetches the ruleset as soon as it changes (`changeDetection: 'stream'`, the default; `'poll'` polls only). `@mocco/sdk-core` gains `MoccoClient.openStream()` and `readServerSentEvents()`.
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
  - @mocco/flags-core@0.1.0
