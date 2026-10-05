---
'@mocco/sdk-core': minor
---

`StatusMaintenance` now has `runId`, `overranAt` and `endNote`: the run whose resumed gate started the window (null for a window an operator scheduled), when it was still in progress past its expected end, and why it ended early when the run failed, was canceled or was rejected.
