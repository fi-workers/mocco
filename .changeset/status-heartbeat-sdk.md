---
'@mocco/sdk-core': minor
'@mocco/node': minor
---

`heartbeat(token).wrap(fn)` pings a Mocco heartbeat monitor around a job: `/start` before `fn`, then success, or `/fail` when `fn` throws (its error is rethrown), and returns `fn`'s result. `success()`, `start()`, `fail()` and `exitCode(code)` send one ping. A ping never throws: a network error, a timeout or a refusal is retried once (except a 404, a wrong token) and then reported to `onError`, a console warning by default, so monitoring never breaks the job. No API key is sent; the `mhb_` token in the path is the credential. Self-hosted installs pass `baseUrl`.
