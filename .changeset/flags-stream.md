---
'@mocco/sdk-core': minor
'@mocco/openfeature-server': minor
---

`@mocco/openfeature-server` listens to Mocco's change stream and fetches the ruleset as soon as it changes (`changeDetection: 'stream'`, the default; `'poll'` polls only). `@mocco/sdk-core` gains `MoccoClient.openStream()` and `readServerSentEvents()`.
