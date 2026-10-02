# @mocco/flags-core

## 0.1.0

### Minor Changes

- 9cd21f2: Feature flags for servers: `@mocco/flags-core` evaluates Mocco's flagd-compatible rulesets locally (the restricted JsonLogic subset, `fractional` bucketing, `sem_ver`), and `@mocco/openfeature-server` is an OpenFeature server provider that polls the key's ruleset with ETags and keeps serving the last good one when Mocco is unreachable. `MoccoClient.getIfChanged()` adds conditional GETs.
