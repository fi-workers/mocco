---
'@mocco/sdk-core': minor
'@mocco/openfeature-server': minor
'@mocco/openfeature-web': minor
'@mocco/openfeature-react-native': minor
---

The flag providers send Mocco how often each flag was read, counted in memory and sent at most once a minute (`telemetry: false` turns it off). Mocco uses the counts only to point out flags that look ready to remove. `@mocco/sdk-core` gains `EvaluationCounter`.
