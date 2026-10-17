# @mocco/node

## 0.2.0

### Minor Changes

- 29a7b09: `heartbeat(token).wrap(fn)` pings a Mocco heartbeat monitor around a job: `/start` before `fn`, then success, or `/fail` when `fn` throws (its error is rethrown), and returns `fn`'s result. `success()`, `start()`, `fail()` and `exitCode(code)` send one ping. A ping never throws: a network error, a timeout or a refusal is retried once (except a 404, a wrong token) and then reported to `onError`, a console warning by default, so monitoring never breaks the job. No API key is sent; the `mhb_` token in the path is the credential. Self-hosted installs pass `baseUrl`.
- b967209: `createMoccoServer({ secretKey })` now has `status`, the project's status page as code over the `/v1` status API (`StatusClient`, on the new `@mocco/sdk-core/status` subpath so browser bundles don't carry it). `status.monitors.upsert(key, input)` creates the monitor with that key or changes it to match, and answers `unchanged` without changing anything when it already does, so CI can run it on every deploy; a new heartbeat's ping token is in the answer that creates it. Also `monitors.list`, `get`, `pause`, `resume`, `delete` and `check`; `incidents.list`, `get`, `create`, `update` and `setComponents`; `maintenances.list`, `schedule` (times as `Date`s or ISO strings) and `cancel`; `pages.list`; `components.list` and `setStatus`; and `locations.list` and `idsOf(codes)` for a monitor's `locationIds`. The key needs `status:read` to read and `status:write` to change; a refusal is a `MoccoError` with its `code`. `MoccoClient` now retries a `PUT` on 429 and 5xx, like a GET.

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

- 5a8f153: First release of Mocco's SDKs: the shared /v1 client (`@mocco/sdk-core`), the browser SDK (`@mocco/js`), the server SDK with `signIdentity()` and `verifyWebhook()` (`@mocco/node`), the React Native SDK with hosted OTA updates and its Expo config plugin (`@mocco/react-native`), and the `mocco-ota` CLI (`@mocco/ota-cli`).

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
