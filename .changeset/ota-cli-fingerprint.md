---
'@mocco/ota-cli': minor
---

`publish` resolves the `fingerprint` runtime version per platform with the project's own `expo-updates fingerprint:generate`, instead of refusing the policy and asking for `--runtime-version`. iOS and Android hash differently, so they become separate releases — one shared value would leave a platform's devices never matching an update. The export also names the platforms it was asked for, so a project that targets web no longer bundles web (and no longer fails the publish on a web-only bundling error).
