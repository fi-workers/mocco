---
title: SDK packages
description: Mocco's published SDKs — @mocco/sdk-core, @mocco/js, @mocco/node, @mocco/react-native (with the ota subpath and Expo config plugin) and @mocco/ota-cli — how they're built, typed against the /v1 schemas, developed without a build, and published with changesets and npm trusted publishing.
type: reference
status: active
created: 2026-10-02
updated: 2026-10-02
confidence: high
owner: andrea
tags: [reference, sdk, npm, publishing, react-native]
related:
  - ../specs/2026-09-24-platform-foundations-design.md
  - ./public-api.md
  - ./ota-hosting.md
code_refs:
  - packages/sdk-core/src/client.ts
  - packages/sdk-core/src/wire.ts
  - packages/sdk-react-native/src/ota.ts
  - packages/sdk-react-native/app.plugin.js
  - packages/backend/src/transport/ext/v1/sdk-contract.test.ts
  - packages/sdk-flags-core/src/flags-core.ts
  - packages/sdk-openfeature-server/src/openfeature-server.ts
  - packages/sdk-openfeature-web/src/openfeature-web.ts
  - packages/sdk-openfeature-react-native/src/openfeature-react-native.ts
  - packages/sdk-core/src/telemetry.ts
  - .github/workflows/publish.yml
---

# SDK packages

Platform foundations §11: one MIT-licensed SDK per platform, product features as subpath exports. The server stays AGPL-3.0; every published package carries its own `LICENSE` (MIT).

| Package | For | What's in it |
|---|---|---|
| `@mocco/sdk-core` | every SDK | `MoccoClient` (the `/v1` fetch client: the key as `Authorization: Bearer`, retries on 429 and 502–504 for GETs and idempotent POSTs with the server's `Retry-After` / `RateLimit-Reset` or backoff, problem+json → `MoccoError` with `status` and `code`), key checks (a secret key is refused in a browser), `EvaluationCounter` (the flag providers' per-minute evaluation counts), `MessengerClient` (a signed-in user's messenger conversations: session from the server-signed identity, kept in the app's storage and reopened on 401; seq-incremental threads; one network retry with the same client message id; polling while watched), and the `/v1` wire types |
| `@mocco/js` | browsers | `createMocco({ publishableKey })`; product clients join as subpaths (`@mocco/js/flags`). Size budget: 10 KB gzipped with sdk-core (`yarn sdk:size`; 2.3 KB today) |
| `@mocco/node` | servers | `createMoccoServer({ secretKey })`, `signIdentity(secret, externalId)` (hex HMAC-SHA256, platform foundations §5), and `verifyWebhook({ body, signatureHeader, secret })` for `mocco-signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` with a 5-minute replay window — the contract Mocco's outbound webhooks will sign with |
| `@mocco/react-native` | React Native apps | `createMoccoNative`; **`/ota`**: `<MoccoOta appId clientId />` (reports `launched` / `emergency_launch`), `reportOtaError()`, `useMoccoUpdate()` (status, `isMandatory`, `applyNow`; downloads in the background and applies a mandatory update when the app returns to the foreground); the Expo config plugin (`"plugins": [["@mocco/react-native", { "manifestUrl", "channel" }]]`); **`/messenger`**: `createMessenger`, `<MessengerProvider client>` (pauses polling in the background, refreshes on return), `useConversations`, `useConversation(id)` (marks new messages read), `useUnreadCount`, `useMessengerCategories`, `useMessenger` — headless, the app draws the screens. Peers: `react`, `react-native`, and `expo-updates` (optional; only `/ota` needs it). No native code |
| `@mocco/flags-core` | servers, flagd-compatible tooling | Local evaluation of a flags ruleset: `parseRuleset`, `resolveFlag` / `resolveTyped`, the restricted JsonLogic subset, `fractional` bucketing (`murmur3`), `sem_ver`. No dependencies, ~4.7 KB gzipped; see [Feature flags](./flags.md#sdks) |
| `@mocco/openfeature-server` | Node servers | `MoccoProvider({ secretKey, changeDetection?, pollIntervalMs?, bootstrap? })`, an OpenFeature server provider over flags-core. It listens to `GET /v1/flags/stream` and fetches `GET /v1/flags/ruleset` (ETag) on each change, polling as a fallback (`changeDetection: 'poll'` polls only), and serves the last good ruleset as STALE when Mocco is down. Peer: `@openfeature/server-sdk` |
| `@mocco/openfeature-web` | browsers | `MoccoWebProvider({ publishableKey })`: OpenFeature's OFREP web provider with Mocco's defaults (Mocco evaluates; the change stream, a 60 s polling fallback, a refresh on tab focus, the last evaluation in `localStorage`). Dependency: `@openfeature/ofrep-web-provider`; peer: `@openfeature/web-sdk` |
| `@mocco/openfeature-react-native` | React Native apps | `MoccoReactNativeProvider({ publishableKey, storage, appState, EventSource })`: OFREP evaluation with the last answers kept in AsyncStorage (served at launch and offline), a refresh on returning to the foreground, polling while active, and the change stream through `react-native-sse`. The app passes those in, so the package has no native or React Native dependency. Peer: `@openfeature/web-sdk` |
| `@mocco/ota-cli` | CI | the `mocco-ota` bin (`init`, `publish`, `promote`, `pause`, `rollback`); `@mocco/common` is bundled in |

## Building and developing

- `yarn sdk:build` builds them in dependency order with tsup: ESM + CJS + `.d.ts` for sdk-core, node, react-native, flags-core and the three OpenFeature providers; ESM for js; an ESM bin for the CLI. `dist/` is git-ignored; `verify` builds before linting.
- Development needs no build: each package's `exports` start with an `@mocco/source` condition pointing at `src/`. TypeScript resolves it through `customConditions` in `tsconfig.base.json`, and each package's `vitest.config.ts` through `resolve.conditions` (the backend's too, for its end-to-end SDK tests such as `flags-sdk.test.ts`). Published consumers never use that condition.
- The SDKs ship **types only** for the wire format (`packages/sdk-core/src/wire.ts`): no zod in a bundle. `transport/ext/v1/sdk-contract.test.ts` asserts with `expectTypeOf` that they match the route schemas in `@mocco/common` (what the SDK sends is what the route accepts; what the route answers is what the SDK types). Add an assertion whenever an SDK calls a new route.
- `@mocco/react-native` declares the slice of its peers' types it uses (`src/types/peer-modules.d.ts`) so `react-native`'s type tree stays out of the repo.

## Publishing

[changesets](https://github.com/changesets/changesets): add a changeset (`yarn changeset`) to a PR that changes a published package. On `main`, `.github/workflows/publish.yml` (SHA-pinned actions) opens or updates the "Version packages" PR; merging it runs `yarn release` (`sdk:build` + `changeset publish`) with **npm trusted publishing** (the job's OIDC token, no npm token) and **provenance**. The app packages (`backend`, `frontend`, `common`, `e2e`) are private and ignored.

Before the first release, someone with npm access must claim the `@mocco` scope (fallback `@moccohq`) and add this repository's `publish.yml` as each package's trusted publisher on npmjs.com. Until then the workflow's publish step fails without publishing anything.
