---
'@mocco/ota-cli': patch
---

Internal: the `runtimeVersion` policies are a named constant instead of bare strings, `init` types the Expo config it rewrites instead of asserting it, and the `expo export` and `fingerprint:generate` command lines and the fingerprint parsing are pure functions, so the two bugs they were introduced to fix are covered by tests rather than by one manual run.
