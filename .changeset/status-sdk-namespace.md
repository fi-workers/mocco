---
'@mocco/sdk-core': minor
'@mocco/node': minor
---

`createMoccoServer({ secretKey })` now has `status`, the project's status page as code over the `/v1` status API (`StatusClient`, on the new `@mocco/sdk-core/status` subpath so browser bundles don't carry it). `status.monitors.upsert(key, input)` creates the monitor with that key or changes it to match, and answers `unchanged` without changing anything when it already does, so CI can run it on every deploy; a new heartbeat's ping token is in the answer that creates it. Also `monitors.list`, `get`, `pause`, `resume`, `delete` and `check`; `incidents.list`, `get`, `create`, `update` and `setComponents`; `maintenances.list`, `schedule` (times as `Date`s or ISO strings) and `cancel`; `pages.list`; `components.list` and `setStatus`; and `locations.list` and `idsOf(codes)` for a monitor's `locationIds`. The key needs `status:read` to read and `status:write` to change; a refusal is a `MoccoError` with its `code`. `MoccoClient` now retries a `PUT` on 429 and 5xx, like a GET.
