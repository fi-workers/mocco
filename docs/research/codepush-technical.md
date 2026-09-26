---
title: CodePush protocol — technical research
description: How Microsoft CodePush works end to end (client, acquisition and management APIs, CLI), the 2026 state of its client and server ecosystem, a comparison with the Expo Updates protocol, store policy, diffs, security, and whether Mocco should also speak CodePush.
type: research
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [research, ota, codepush, expo-updates, protocol]
related:
  - ./ota-competitors.md
  - ./codepush-market.md
  - ../specs/2026-09-24-ota-design.md
  - ../specs/2026-09-25-ota-release-control-design.md
---

# CodePush protocol: technical research

Question: should Mocco, which speaks Expo Updates protocol v1 to the stock `expo-updates` client (`docs/specs/2026-09-24-ota-design.md`), **also** speak the Microsoft CodePush client protocol, so that teams leaving App Center can switch by changing a server URL and a deployment key?

Method: I read the archived Microsoft sources directly (shallow clones of `microsoft/code-push-server`, `microsoft/react-native-code-push`, the `code-push@4.2.3` npm SDK the client embeds, and the current forks). The protocol claims below come from source files, not blog posts. Status data comes from the GitHub API and the npm registry, both queried on 2026-09-25. Web search was not available for this run, so a few market claims stay marked "(unverified)".

Short answer (section 8): keep Expo protocol as the primary contract. Add a **read-only CodePush acquisition shim** (3 endpoints) as a *migration* feature later, scoped to the one case where it has unique value: teams whose installed binaries already point at a CodePush server hostname they control. Do not build the CodePush management API or CLI compatibility.

---

## 1. How CodePush works end to end

### 1.1 Moving parts

| Part | What it is | Source |
|---|---|---|
| Client | `react-native-code-push` (JS + native iOS/Android module). Embeds the `code-push` npm package's `AcquisitionManager` for HTTP. | [CodePush.js](https://github.com/microsoft/react-native-code-push/blob/master/CodePush.js), [package.json](https://github.com/microsoft/react-native-code-push/blob/master/package.json) (`"code-push": "4.2.3"`) |
| Acquisition API | Public, unauthenticated device endpoints: `update_check`, `report_status/deploy`, `report_status/download`. Keyed by a **deployment key**. | [api/script/routes/acquisition.ts](https://github.com/microsoft/code-push-server/blob/main/api/script/routes/acquisition.ts) |
| Management API | Authenticated REST (`Authorization: Bearer <accessKey>`) for apps, deployments, releases, promote, rollback, metrics, collaborators. | [api/script/routes/management.ts](https://github.com/microsoft/code-push-server/blob/main/api/script/routes/management.ts) |
| CLI | `code-push-standalone` (formerly `appcenter codepush` / `code-push`): `release-react`, `promote`, `rollback`, `patch`, `deployment`, `access-key`. | [cli/README.md](https://github.com/microsoft/code-push-server/blob/main/cli/README.md) |
| Storage | Package zips in blob storage (Azure in the reference server); acquisition responses cached in Redis. | [storage/azure-storage.ts](https://github.com/microsoft/code-push-server/blob/main/api/script/storage/azure-storage.ts), [redis-manager.ts](https://github.com/microsoft/code-push-server/blob/main/api/script/redis-manager.ts) |

**Data model.** An *app* is per platform by convention (`MyApp-iOS`, `MyApp-Android`). Each app has *deployments* (default `Staging`, `Production`), and each deployment has an opaque **deployment key** and an append-only **package history**. A package (release) has: `label` (`v1`, `v2`, … per deployment, server-generated), `appVersion` (a semver *range*, the "target binary version"), `packageHash`, `blobUrl`, `size`, `isMandatory`, `isDisabled`, `rollout` (1–100 or null), `description`, `diffPackageMap` (`{[fromPackageHash]: {url, size}}`), `releaseMethod` (`Upload` | `Promote` | `Rollback`), `originalLabel`, `originalDeployment`, `releasedBy`, `uploadTime` ([rest-definitions.ts](https://github.com/microsoft/code-push-server/blob/main/api/script/types/rest-definitions.ts)).

### 1.2 Client configuration

- **iOS** `Info.plist`: `CodePushDeploymentKey`, `CodePushServerURL` (default `https://codepush.appcenter.ms/`), `CodePushPublicKey` ([CodePushConfig.m](https://github.com/microsoft/react-native-code-push/blob/master/ios/CodePush/CodePushConfig.m)).
- **Android** `strings.xml`: `CodePushDeploymentKey`, `CodePushServerUrl`, `CodePushPublicKey`; or the `CodePush(...)` / `CodePushBuilder.setServerUrl()` constructor ([CodePush.java](https://github.com/microsoft/react-native-code-push/blob/master/android/app/src/main/java/com/microsoft/codepush/react/CodePush.java)).
- **Runtime override.** JS can override the **deployment key** per call (`checkForUpdate(deploymentKey)` / `sync({deploymentKey})`), which enables "dynamic deployment assignment". The **server URL cannot be overridden from JS**; it comes only from native config ([CodePush.js `checkForUpdate`](https://github.com/microsoft/react-native-code-push/blob/master/CodePush.js)). *Consequence: changing the server URL always needs a new binary unless the old hostname is re-pointed at the new server.*
- The binary's own bundle hash: Android's `codepush.gradle` writes a `CodePushHash` asset at build time so the client does not re-download a bundle identical to the embedded one ([issue #498 thread](https://github.com/microsoft/react-native-code-push/issues/498)). iOS sends `packageHash` of the binary only when there is no local update.

### 1.3 The sync flow

`codePush(options)(App)` (HOC) or `codePush.sync(options)` runs this sequence ([CodePush.js](https://github.com/microsoft/react-native-code-push/blob/master/CodePush.js)):

1. `notifyAppReady()` first. This confirms the currently running update and flushes any pending status report (`report_status/deploy`).
2. **Check.** `GET {serverUrl}v0.1/public/codepush/update_check?...` with the current package (label, hash, appVersion).
3. Client-side filters. It returns null if the server says `update_app_version`, if the hash equals the running package, or if it equals the binary hash. If `failedInstall` is true and `ignoreFailedUpdates` (default `true`), it skips the update unless `rollbackRetryOptions` allows a retry (defaults: `delayInHours: 24`, `maxRetryAttempts: 1`).
4. Optional `updateDialog` (off by default. Microsoft advises keeping it off for App Store apps, see §5).
5. **Download** the zip from `download_url`, then `report_status/download`.
6. **Install.** Unzip; for a diff, copy the current package, overlay the changed files and delete the files listed in `hotcodepush.json`; verify the hash and signature; write the pending-update record.
7. **Apply** according to install mode.

Options and defaults (from `sync`):

| Option | Values | Default |
|---|---|---|
| `checkFrequency` | `ON_APP_START` (0), `ON_APP_RESUME` (1), `MANUAL` (2) | `ON_APP_START` |
| `installMode` | `IMMEDIATE`, `ON_NEXT_RESTART`, `ON_NEXT_RESUME`, `ON_NEXT_SUSPEND` | `ON_NEXT_RESTART` |
| `mandatoryInstallMode` | same | `IMMEDIATE` |
| `minimumBackgroundDuration` | seconds, for `ON_NEXT_RESUME`/`ON_NEXT_SUSPEND` | `0` |
| `ignoreFailedUpdates` | bool | `true` |
| `rollbackRetryOptions` | `{delayInHours, maxRetryAttempts}` | `null` (no retry); defaults `24`/`1` if enabled |
| `updateDialog` | object or `true` | `null` |
| `deploymentKey` | string | native config |

Other API: `getUpdateMetadata(UpdateState.RUNNING|PENDING|LATEST)`, `restartApp(onlyIfUpdateIsPending)`, `allowRestart`/`disallowRestart`, `clearUpdates`, `LocalPackage.isFirstRun`/`failedInstall` ([typings](https://github.com/microsoft/react-native-code-push/blob/master/typings/react-native-code-push.d.ts)).

### 1.4 `notifyAppReady` and automatic rollback

Rollback is **entirely client-side, and it does not detect crashes**. It is a "did the new bundle reach `notifyAppReady`" watchdog ([CodePush.m `initializeUpdateAfterRestart`](https://github.com/microsoft/react-native-code-push/blob/master/ios/CodePush/CodePush.m)):

- On install, the pending update is saved with `isLoading = NO`.
- On the next start, the native side flips it to `isLoading = YES` and loads the new bundle.
- If the app starts again and finds `isLoading = YES` (so `notifyAppReady` was never called), it logs *"Update did not finish loading the last time, rolling back to a previous version"*. It then calls `rollbackPackage` (back to the previous package or the binary), adds the hash to `CODE_PUSH_FAILED_UPDATES`, and on the next successful start reports `DeploymentFailed` for that label.
- A crash *after* `notifyAppReady` does not roll back. The HOC calls `sync`, which calls `notifyAppReady` early, so in practice rollback covers only "the bundle crashes before the root component mounts".

### 1.5 Binary version targeting (semver ranges)

- The client sends `app_version` = `CFBundleShortVersionString` / `versionName`. Each release's `appVersion` is a **semver range** (`*`, `1.2.3`, `1.2.x`, `~1.2.3`, `^1.2.3`, `1.0.0 - 1.0.5`, `>=1.2.3 <1.2.7`). The server normalizes a client `2` to `2.0.0` and `2.0` to `2.0.0` ([acquisition.ts `createResponseUsingStorage`](https://github.com/microsoft/code-push-server/blob/main/api/script/routes/acquisition.ts), [cli README targetBinaryVersion table](https://github.com/microsoft/code-push-server/blob/main/cli/README.md)).
- `release-react` infers the version from `Info.plist` / `build.gradle` unless `--targetBinaryVersion` is given.
- **There is no native-compatibility fingerprint.** If a developer changes native code without bumping the store version, CodePush will ship a JS bundle to a binary it does not match. This is CodePush's main footgun, and Expo's `runtimeVersion: {policy: "fingerprint"}` exists to fix it.

### 1.6 Server selection algorithm (`getUpdatePackage`)

From [utils/acquisition.ts](https://github.com/microsoft/code-push-server/blob/main/api/script/utils/acquisition.ts), which is worth reproducing exactly because a compatible server has to match it:

1. Walk the deployment history **newest to oldest**. Mark `foundRequestPackageInHistory` when the entry's `label` equals the request label (or the `packageHash` if no label was sent; if neither was sent, treat it as found).
2. Skip `isDisabled` entries (and unfinished rollouts when computing the non-rollout answer).
3. The first enabled entry is `latestEnabledPackage`. Skip entries whose range does not satisfy `app_version` (unless `is_companion`). The first satisfying one is `latestSatisfyingEnabledPackage`.
4. If the client's package was found, stop. Else if the entry is mandatory, set `shouldMakeUpdateMandatory` and stop. **Result: an update is mandatory if any skipped release in between was mandatory.** (This is Mocco's open question 5.)
5. If nothing satisfies: set `shouldRunBinaryVersion=true`. If the client is older than the latest release's range, set `update_app_version=true` and `appVersion=<range>` (a "store update available" hint).
6. If `diffPackageMap[request.packageHash]` exists, `download_url`/`package_size` point at the diff zip. Otherwise they point at the full `blobUrl`.
7. **Rollout.** If the latest satisfying package has `rollout` in 1..99, the server computes *both* answers (with and without the rollout package) and caches both. Per request it picks with `isSelectedForRollout(clientUniqueId, rollout, label||packageHash)`: a Java-style 32-bit string hash `h = (h<<5) - h + c` over `clientUniqueId + "-" + label`, then `abs(h) % 100 < rollout` ([rollout-selector.ts](https://github.com/microsoft/code-push-server/blob/main/api/script/utils/rollout-selector.ts)). A missing `client_unique_id` means no rollout package. Buckets are re-salted per release label.

### 1.7 Acquisition API (wire format)

Base: `{serverUrl}` + `v0.1/public/codepush/` (current clients). Legacy camelCase aliases exist: `/updateCheck`, `/reportStatus/deploy`, `/reportStatus/download`. The server accepts both snake and camel parameter names ([acquisition.ts](https://github.com/microsoft/code-push-server/blob/main/api/script/routes/acquisition.ts)).

Request headers sent by the client ([request-fetch-adapter.js](https://github.com/microsoft/react-native-code-push/blob/master/request-fetch-adapter.js)):

```
Accept: application/json
Content-Type: application/json
X-CodePush-Plugin-Name: react-native-code-push      (or the fork's package name)
X-CodePush-Plugin-Version: 9.0.1
X-CodePush-SDK-Version: 4.2.3                        (the embedded code-push SDK)
```

The server reads `X-CodePush-SDK-Version`: SDKs `>= 1.5.2-beta` use the "new metrics" path ([rest-headers.ts](https://github.com/microsoft/code-push-server/blob/main/api/script/utils/rest-headers.ts)). There is **no authentication**. The deployment key is the only credential, and it ships in every binary.

**`GET /v0.1/public/codepush/update_check`** (query string, built in [acquisition-sdk.js](https://www.npmjs.com/package/code-push/v/4.2.3)):

```
deployment_key=<key>&app_version=1.4.0&package_hash=<sha256 hex|omitted>
&is_companion=<bool|omitted>&label=v17&client_unique_id=<device id>
```

Response `200`:

```json
{
  "update_info": {
    "download_url": "https://cdn.example/packages/abc.zip",
    "description": "Fix checkout crash",
    "is_available": true,
    "is_disabled": false,
    "is_mandatory": false,
    "app_version": "1.4.0",
    "target_binary_range": "1.4.0",
    "package_hash": "5b1c…e9",
    "label": "v18",
    "package_size": 2873410,
    "update_app_version": false,
    "should_run_binary_version": false
  }
}
```

- No update: `is_available: false` with empty strings. "Needs store update": `update_app_version: true` and `target_binary_range: "<range>"`.
- The client maps `download_url`, `description`, `label`, `target_binary_range`→`appVersion`, `is_mandatory`, `package_hash`, `package_size`. It ignores `should_run_binary_version` in the JS SDK.
- Non-2xx is an error (`CodePushHttpError`). Only for `appcenter.ms` URLs does a non-recoverable status disable further calls for the session.

**`POST /v0.1/public/codepush/report_status/deploy`** (after `notifyAppReady`, or after a rollback on the next start):

```json
{ "app_version": "1.4.0", "deployment_key": "<key>", "client_unique_id": "<id>",
  "label": "v18", "status": "DeploymentSucceeded",
  "previous_label_or_app_version": "v17", "previous_deployment_key": "<key>" }
```

`status` is `DeploymentSucceeded` | `DeploymentFailed`. For a binary-version report, `label`/`status` are omitted. Response `200` with an empty body. The server uses it for active/installed/failed counts per label.

**`POST /v0.1/public/codepush/report_status/download`**:

```json
{ "client_unique_id": "<id>", "deployment_key": "<key>", "label": "v18" }
```

**Package format.** The zip contains a `CodePush/` folder holding the bundle (it **must** have the same file name as the binary's: `main.jsbundle` / `index.android.bundle`) and the Metro assets. There is an optional `.codepushrelease` (a JWT, §7). A diff zip additionally has `hotcodepush.json` = `{"deletedFiles": [...]}` ([CodePushPackage.m](https://github.com/microsoft/react-native-code-push/blob/master/ios/CodePush/CodePushPackage.m)).

**`packageHash`** = `sha256_hex(JSON.stringify(sorted(["<relative/path>:<sha256_hex(file)>", ...])))`. It ignores `__MACOSX/`, `.DS_Store` and `.codepushrelease` ([cli/script/hash-utils.ts](https://github.com/microsoft/code-push-server/blob/main/cli/script/hash-utils.ts), [CodePushUpdateUtils.m](https://github.com/microsoft/react-native-code-push/blob/master/ios/CodePush/CodePushUpdateUtils.m)). A compatible server must compute exactly this, because the client re-computes it (for diffs, or whenever signing is on) and compares.

### 1.8 Diff updates

- These are **file-level diffs, not byte diffs**. On release and promote, the server compares file manifests with the previous package(s) and builds a zip of only the new or changed files plus `hotcodepush.json` listing deletions. `maxPackagesToDiff` defaults to **1** ([package-diffing.ts](https://github.com/microsoft/code-push-server/blob/main/api/script/utils/package-diffing.ts)).
- A one-line JS change still re-downloads the whole bundle file (usually most of the payload). Only unchanged images are saved.
- Byte-level patches (bsdiff/HDiffPatch) exist only in forks (§2, §6).

### 1.9 Management API and CLI

Management requests send `Accept: application/vnd.code-push.v2+json`, `Authorization: Bearer <accessKey>` and `X-CodePush-SDK-Version` ([management-sdk.ts](https://github.com/microsoft/code-push-server/blob/main/cli/script/management-sdk.ts)). Routes ([management.ts](https://github.com/microsoft/code-push-server/blob/main/api/script/routes/management.ts)):

```
GET/POST/PATCH/DELETE /accessKeys[/:name]      DELETE /sessions/:createdBy
GET/POST /apps   GET/PATCH/DELETE /apps/:app   POST /apps/:app/transfer/:email
GET/POST/DELETE /apps/:app/collaborators[/:email]
GET/POST /apps/:app/deployments   GET/PATCH/DELETE /apps/:app/deployments/:dep
POST  /apps/:app/deployments/:dep/release        (multipart: file "package" + field "packageInfo" JSON)
PATCH /apps/:app/deployments/:dep/release        (patch metadata of a label)
POST  /apps/:app/deployments/:src/promote/:dest
POST  /apps/:app/deployments/:dep/rollback/:targetRelease?
GET/DELETE /apps/:app/deployments/:dep/history
GET   /apps/:app/deployments/:dep/metrics
```

CLI verbs ([cli README](https://github.com/microsoft/code-push-server/blob/main/cli/README.md)):

- **`release-react <app> <platform>`** runs `react-native bundle`, optionally compiles to Hermes bytecode (`--useHermes`, `--extraHermesFlags`; it invokes `hermesc -emit-binary` and composes source maps, see [react-native-utils.ts](https://github.com/microsoft/code-push-server/blob/main/cli/script/react-native-utils.ts)), optionally signs (`--privateKeyPath`), then uploads. Other flags: `-d <deployment>`, `-t/--targetBinaryVersion`, `-m/--mandatory`, `-x/--disabled`, `-r/--rollout`, `--description`, `--outputDir`, `--sourcemapOutput`, `--plistFile`/`--gradleFile`.
- **`promote <app> <src> <dest>`** copies a release, creating a new label in dest. It propagates `description`/`mandatory`/`targetBinaryVersion` but **not `rollout`**.
- **`rollback <app> <dep> [--targetRelease vN]`** appends a *new* history entry that copies the previous (or target) package (`releaseMethod: "Rollback"`) and clears any active rollout. Devices "roll forward" to old content.
- **`patch <app> <dep> [-l label] [-m] [-x] [-r N%] [-t range] [--des]`** edits metadata in place. Rollout can only increase. Contents are immutable.

---

## 2. Status of the Microsoft repos and the maintained forks (2026-09-25)

### 2.1 Microsoft upstream

| Repo | Status | Last release | Notes |
|---|---|---|---|
| `microsoft/react-native-code-push` | **Archived** (last push 2025-05-20T11:58Z) | **v9.0.1**, 2024-12-19 (npm `react-native-code-push@9.0.1`) | README: *"React Native CodePush won't support new Architecture. In order to use this plugin on React Native versions starting from 0.76 you will need to opt out from new architecture."* ([README](https://github.com/microsoft/react-native-code-push)) |
| `microsoft/code-push-server` | **Archived** (last push 2025-05-20T11:27Z), MIT, "as is", no support | none (CLI published as `code-push-standalone@0.0.1`, 2025-03-24) | README: *"CodePush, along with other App Center features, was also retired on March 31, 2025. Consequently, we are archiving this repository."* ([repo](https://github.com/microsoft/code-push-server)) |
| `microsoft/code-push` (SDK + old CLI) | **Archived** 2025-05-20 | `code-push@4.2.3` | The acquisition SDK every client fork still embeds. |

**New Architecture reality.** RN 0.82 (2025-10-08) made the New Architecture the only architecture: *"if you try to set `newArchEnabled=false` on Android, or … `RCT_NEW_ARCH_ENABLED=0` on iOS, these will be ignored"*, and *"React Native 0.81 or Expo SDK 54 … are the last versions that allow you to use the Legacy Architecture"* ([RN 0.82 blog](https://reactnative.dev/blog/2025/10/08/react-native-0.82)). So **the Microsoft client is dead for any app on RN ≥ 0.82**. It still runs on legacy-arch RN ≤ 0.81 installs (or in interop mode, reliability unverified).

### 2.2 Maintained CodePush-protocol clients

npm weekly downloads for 2026-09-15..21 come from `api.npmjs.org/downloads/point/last-week/<pkg>`.

| Package | Repo / owner | Latest | RN / New Arch | Wire protocol | Downloads/wk |
|---|---|---|---|---|---|
| `react-native-code-push` | microsoft (archived) | 9.0.1 (2024-12) | Old arch only; ≤ 0.81 | CodePush v0.1 | 24,319 |
| `@code-push-next/react-native-code-push` | [codemagic-ci-cd/react-native-code-push](https://github.com/codemagic-ci-cd/react-native-code-push) (the former `CodePushNext` org now redirects here) | **10.4.3** (2026-08-10) | 0.76–0.79 → v10.0+, 0.80 → 10.1+, 0.81 → 10.3+, **0.82+ → 10.4+ (New Arch)**; Expo config plugin (`expo.js`) | **Unmodified** (still `code-push@4.2.3` SDK) | 35,770 |
| `@revopush/react-native-code-push` | [revopush/react-native-code-push](https://github.com/revopush/react-native-code-push) | **2.6.2** (2026-09-13), peer `react-native >= 0.83` | RN < 0.76 unsupported; 0.76–0.82 → 2.5.1; 0.83+ → 2.6.x; Expo 52–54 / 55+ plugins | **Extended superset**: `@revopush/code-push@4.6.0` adds `build_number` and `asset_hash` to requests and reads `bundle_diff_blob_url`, `asset_download_url`, `asset_hash`, `bundle_hash`, `bundle_blob_url`, `base_package.package_hash` from `update_info`. Byte-level patches use a bundled HDiffPatch framework (`DiffUpdates.xcframework`, `hpatch_objc.h`). | 8,197 |
| `@bravemobile/react-native-code-push` | [Soomgo-Mobile/react-native-code-push](https://github.com/Soomgo-Mobile/react-native-code-push) | 13.3.1 (2026-09-17) | RN 0.77–0.86, TurboModule since 13.0.0 | **Not the CodePush server protocol**: *"CodePush without an update server"*, static hosting plus user-supplied release-history resolver | 3,477 |

Adjacent, non-CodePush-protocol clients: `react-native-stallion` 2.4.2 (own protocol, bspatch; 5,008/wk), `@hot-updater/react-native` 0.36.15 (own protocol; 25,569/wk), `@codemagic/react-native-patch` 0.5.0 (78/wk). For scale, `expo-updates` 57.0.23 had **2,695,534/wk**.

About **68K weekly downloads** use clients that speak the vanilla or extended CodePush protocol (24K legacy + 36K code-push-next + 8K Revopush). That is about 2.5% of `expo-updates`, but it is real and concentrated in exactly the App Center refugee segment.

**Trend signal.** Codemagic, which maintains the most-downloaded New-Arch CodePush client, now puts this at the top of its README: *"We build Codemagic Patch … where our new development happens, and we recommend it for new projects."* Codemagic Patch is a *new* protocol with a new SDK (`@codemagic/react-native-patch`), two base URLs (`CodemagicPatchApiUrl` + `CodemagicPatchDownloadBaseUrl`), and it states: *"No OTA path across the migration. Devices running the CodePush SDK can never receive a Codemagic Patch release"* and *"Deployment key values are new — CodePush keys cannot be reused"* ([migrate-from-codepush.md](https://github.com/codemagic-ci-cd/codemagic-patch/blob/main/docs/migrate-from-codepush.md), repo created 2026-06-30). The CodePush client lineage is being maintained for existing users while the vendors move new work elsewhere.

---

## 3. Self-hosted CodePush-compatible servers

| Server | License | Maintenance | Protocol coverage | Notes |
|---|---|---|---|---|
| [microsoft/code-push-server](https://github.com/microsoft/code-push-server) | MIT | Archived 2025-05-20 | Reference: acquisition (both URL styles), full management API, file-level diffs, Redis cache, GitHub/Microsoft OAuth for the CLI | Azure Storage or local JSON storage only; Redis required. Best spec-by-source. |
| [lisong/code-push-server](https://github.com/lisong/code-push-server) | MIT | Effectively dormant: last code release v5.7.1 on 2019-11-17, last commit 2023-08 (README) | Acquisition + management for the old `code-push` 2.x/3.x CLI; storage local/qiniu/s3/oss/tencentcloud; custom `is_use_diff_text` diff extension | MySQL. 1,868 stars. Common in China. |
| [shm-open/code-push-server](https://github.com/shm-open/code-push-server) | MIT | Light: npm `@shm-open/code-push-server@2.1.6` (2024-02-23); last `master` commit 2024-03-04 (later pushes are Renovate branches) | Sticks to the official client and drops lisong's custom diff; storage local/qiniu/s3/oss/tencentcloud; optional Redis cache (`UPDATE_CHECK_CACHE`); companion `shm-open/code-push-cli` | Default admin `admin`/`123456`. |
| Codemagic hosted CodePush | proprietary | Active (unverified pricing) | Vanilla CodePush (their client is unmodified) | [codemagic.io/codepush](https://codemagic.io/codepush/) |
| Revopush | proprietary | Active | Vanilla plus extensions (§2.2); own CLI `@revopush/code-push-cli@0.0.15` (2026-08-26) | SOC 2 claimed in README |

There is no actively maintained, general-purpose OSS server that implements the full CodePush management API on modern infrastructure (Postgres + S3 + CDN). The field is either archived or light maintenance. That gap is an opportunity, but also evidence that demand for a *self-hosted* CodePush server is soft. (A broader GitHub survey of smaller forks was not possible without web search; unverified.)

---

## 4. Expo Updates protocol vs CodePush protocol

### 4.1 Capability matrix

| Capability | CodePush (Microsoft client + server) | Expo Updates v1 (`expo-updates`) |
|---|---|---|
| Spec | None. The de facto spec is archived source. | Public spec ([expo-updates-1](https://docs.expo.dev/technical-specs/expo-updates-1/)) and reference server |
| Client maintenance | Microsoft archived. Forks: code-push-next (Codemagic, deprioritized), Revopush (vendor-extended) | Expo, ships with every SDK (57.x now) |
| Compatibility key | `appVersion` semver **range**, set per release | `runtimeVersion` exact string; policies `appVersion`, `nativeVersion`, **`fingerprint`** (hash of native project) ([Updates docs](https://docs.expo.dev/versions/latest/sdk/updates/)) |
| Channels | Deployment = key baked into binary; JS can switch key | `expo-channel-name` request header; server maps channel→branch; runtime override via `setUpdateURLAndRequestHeadersOverride` (needs `disableAntiBrickingMeasures`) |
| Rollout | Server-side %, hash of `client_unique_id + label` | Server-side (Mocco: `EAS-Client-ID` bucket); not in the protocol spec |
| Mandatory | First-class `is_mandatory`, sticky across skipped releases, `mandatoryInstallMode` | Not in protocol. Convention via `extra`; Mocco's JS helper |
| Rollback (server) | `rollback` = re-release old package as new label | Republish (new id/createdAt) or signed `rollBackToEmbedded` directive |
| Rollback (client) | Watchdog: no `notifyAppReady` before the next start → revert | Error recovery / "emergency launch" to embedded or last good update ([Updates docs](https://docs.expo.dev/versions/latest/sdk/updates/)) |
| Disable a release | `isDisabled` flag | Server stops serving it |
| Code signing | Optional RS256 JWT over `packageHash` inside the zip (§7) | Optional `rsa-v1_5-sha256` over the manifest (and directives); assets pinned by hash in the signed manifest; certificate chain in the binary |
| Integrity without signing | Hash verified **only for diff updates**; full updates are not re-hashed unless a signature exists | Every asset hash MUST be verified by the client (spec) |
| Assets | One zip per release (bundle + all assets) | Content-addressed per asset; client downloads only missing hashes (natural asset dedupe) |
| Diffs | File-level zip diff vs the previous 1 package | **bsdiff** of the launch asset (Hermes bytecode), beta SDK 55, default SDK 56, about 75% smaller ([Expo blog](https://expo.dev/blog/ship-smaller-ota-updates-bundle-diffing-comes-to-ota-updates-in-sdk-55)) |
| Hermes | CLI compiles HBC (`--useHermes`). HBC version tied to the binary's Hermes, and only `appVersion` guards it | `expo export` emits HBC. `fingerprint` changes when RN/Hermes changes. |
| Telemetry | `report_status/deploy`/`download` → active/installed/failed/downloaded per label | Not in the protocol. Mocco has its own `/events` + JS helper; `Expo-Current-Update-ID` on each check gives adoption for free |
| Store-update hint | `update_app_version` + `target_binary_range` | None |
| Bare RN support | Native module only; no Expo needed | Needs `expo` modules: `npx install-expo-modules`, `expo-updates`, `registerRootComponent`, module name `"main"` ([bare guide](https://docs.expo.dev/bare/updating-your-app/)) |

### 4.2 Can `expo-updates` run without the Expo SDK?

Not without the `expo` package. The bare guide says to run `npx install-expo-modules@latest` (which adds `expo`/`expo-modules-core` and switches to Expo CLI/Metro config), then `npx expo install expo-updates`, then set `EXUpdatesURL`/`EXUpdatesRuntimeVersion` in `Expo.plist` and `expo.modules.updates.EXPO_UPDATE_URL`/`EXPO_RUNTIME_VERSION` in `AndroidManifest.xml`, and use `registerRootComponent` ([docs.expo.dev/bare/updating-your-app](https://docs.expo.dev/bare/updating-your-app/)). You do **not** need Expo Go, EAS Build, a managed workflow or `app.json`-driven prebuild. You do take a dependency on Expo modules and Expo CLI bundling. For some bare-RN shops this is the real switching cost that CodePush compatibility would avoid.

### 4.3 Official CodePush → EAS Update migration

Expo publishes **"Migrate from CodePush"** ([docs.expo.dev/eas-update/codepush](https://docs.expo.dev/eas-update/codepush/)):

- Steps: upgrade to the latest SDK, *"uninstall CodePush"*, add an `expo` config, follow EAS Update setup, then *"rebuild and submit"* to the stores.
- Concept map: Deployments → Channels & Branches; version targeting → `runtimeVersion`; `--mandatory` → custom logic via `extra`; `sync()` → `Updates.*` / `setUpdateURLAndRequestHeadersOverride`.
- Its key line: *"To avoid conflicts and unexpected behavior, it's recommended to uninstall CodePush if you're using EAS Update."*

Every migration path (Expo's, Codemagic Patch's, Stallion's) requires one store release. The only way to reach **already-installed** CodePush binaries OTA is a server that speaks CodePush on the hostname baked into those binaries.

---

## 5. App store policy for OTA JS updates

**Apple, Developer Program License Agreement §3.3.1(B) "Executable Code"** (current text, [DPLA](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/)):

> "Except as set forth in the next paragraph, an Application may not download or install executable code. Interpreted code may be downloaded to an Application but only so long as such code: (a) does not change the primary purpose of the Application by providing features or functionality that are inconsistent with the intended and advertised purpose of the Application (b) does not bypass signing, sandbox, or other security features of the OS; and (c) for Applications distributed on the App Store, does not create a store or storefront for other Applications."

**App Review Guideline 2.5.2** ([guidelines](https://developer.apple.com/app-store/review/guidelines/)):

> "Apps should be self-contained in their bundles, and may not read or write data outside the designated container area, nor may they download, install, or execute code which introduces or changes features or functionality of the app, including other apps."

The "interpreted code" carve-out in the DPLA is what the whole RN OTA industry relies on. There is no guideline numbered 3.3.1 in the Review Guidelines; the "3.3.1" people cite is the DPLA section. Guideline 4.7 separately allows HTML5/JS mini-apps and mini-games.

**Google Play, Device and Network Abuse** ([policy](https://support.google.com/googleplay/android-developer/answer/9888379)):

> "An app distributed via Google Play may not modify, replace, or update itself using any method other than Google Play's update mechanism. Likewise, an app may not download executable code (such as dex, JAR, .so files) from a source other than Google Play. This restriction does not apply to code that runs in a virtual machine or an interpreter where either provides indirect access to Android APIs (such as JavaScript in a webview or browser)."

What is allowed and what triggers rejection:

- **Allowed:** JS/Hermes-bytecode bundles and assets that fix bugs or iterate within the app's reviewed purpose. Hermes bytecode runs in the Hermes VM, so it falls under "interpreter/VM"; no rejections specific to HBC are known (unverified).
- **Not allowed:**
  - Anything native: new `.so`/dex/frameworks, new permissions or entitlements.
  - Changing the app's primary or advertised purpose.
  - Using OTA to evade review (flipping on features hidden from reviewers).
  - An in-app storefront for other code.
  - Bypassing OS security.
- **Historical enforcement:**
  - In March 2017 Apple sent mass warnings to apps using JSPatch/Rollout-style *native method swizzling from downloaded JS* ([JSPatch issue #746, 2017-03-07, 620 comments](https://github.com/bang590/JSPatch/issues/746)). The trigger was JS that calls arbitrary native APIs (bypassing the "security features" clause), not RN bundles as such.
  - On Android, an app was rejected under Device and Network Abuse when it downloaded a CodePush update immediately on first launch during review. Removing `sync()` fixed it, and Microsoft's advice was to not publish an OTA update until the binary is live ([react-native-code-push#498](https://github.com/microsoft/react-native-code-push/issues/498)).
  - Microsoft also advised not enabling `updateDialog` on App Store builds ([README "Store Guideline Compliance"](https://github.com/microsoft/react-native-code-push#store-guideline-compliance)).

Implications for Mocco's governance pitch: the approval gate is a natural place for a "store-policy checklist" (native diff detection via fingerprint, "no new permissions", "reviewed-purpose" attestation). Expo's `fingerprint` runtime version gives Mocco a machine check that CodePush's `appVersion` cannot.

---

## 6. Hermes bytecode, sizes, and differential updates

- **Hermes bundles.** Production RN bundles are Hermes bytecode (`.hbc` renamed to the bundle name). CodePush's `release-react --useHermes` runs `hermesc -emit-binary -out <bundle>.hbc [-output-source-map]` ([react-native-utils.ts](https://github.com/microsoft/code-push-server/blob/main/cli/script/react-native-utils.ts)). HBC is tied to the Hermes version in the binary, so a bundle built with a different RN/Hermes than the binary can fail to load. With CodePush that surfaces as the §1.4 rollback. With Expo `fingerprint` it is prevented.
- **Typical sizes** (vendor examples; distributions unverified):
  - Expo cites "a typical 3MB update" going to about 0.75 MB with bsdiff ([Expo blog](https://expo.dev/blog/ship-smaller-ota-updates-bundle-diffing-comes-to-ota-updates-in-sdk-55)).
  - hot-updater cites "a 10 MB archive" going to "a 600 KB patch file" ([bundle-diffing.mdx](https://github.com/gronxb/hot-updater/blob/main/docs/content/docs/guides/bundle-diffing.mdx)).
  - Large production apps commonly ship 5–20 MB HBC bundles (unverified).
- **Who diffs how:**

| System | Diff unit | Algorithm | Bases | Where generated |
|---|---|---|---|---|
| CodePush (MS) | Whole files (zip of changed files + `deletedFiles`) | none (file copy) | previous 1 package (`maxPackagesToDiff = 1`) | Server, on release/promote |
| Expo / EAS (SDK 55+) | Launch asset (HBC) | bsdiff | "the second-newest update on the channel"; not embedded bundles | Server, minutes after publish; served only when "meaningfully smaller" |
| hot-updater | File reuse for all files + byte patch for HBC | bsdiff (Rust `bsdiff` 0.2.1 → WASM, `@hot-updater/bsdiff`) + bspatch on device | `patch.maxBaseBundles` default 3 | CLI at deploy time |
| Stallion | Bundle patch ("up to 98% smaller") | bspatch on device (`StallionBSPatch.swift`, `bspatch.c`, `StallionBSPatch.java`) | (unverified) | Stallion cloud |
| Revopush 2.x | Bundle + assets split; byte patches, also against the **store binary's** bundle (`revopush release-native`) | HDiffPatch (`hpatch`) | base package / native base release | Revopush cloud |

If Mocco serves CodePush, the vanilla client only understands file-level diffs. Byte patches would need Revopush's proprietary extension fields, which only Revopush's SDK reads.

---

## 7. Security

### 7.1 CodePush code signing

- **Signing.** `release-react --privateKeyPath key.pem` computes `packageHash` (§1.7) and writes `CodePush/.codepushrelease` = RS256 JWT with claims `{"claimVersion":"1.0.0","contentHash":"<packageHash>"}` ([sign.ts](https://github.com/microsoft/code-push-server/blob/main/cli/script/sign.ts)).
- **Verifying.**
  - The app embeds `CodePushPublicKey` (PEM in `Info.plist` / `strings.xml`).
  - iOS hard-codes `RS256` (JWT lib); Android uses Nimbus `RSASSAVerifier` 9.37.3, so there is no `alg: none` confusion.
  - The client re-hashes the unzipped folder, checks it equals the server-reported `packageHash`, then checks the JWT `contentHash` equals that hash.
  - If a public key is configured and the JWT is missing, install fails: *"Public key was provided but there is no JWT signature"* ([CodePushPackage.m](https://github.com/microsoft/react-native-code-push/blob/master/ios/CodePush/CodePushPackage.m)).
- **Gaps (from reading the source):**
  1. **Metadata is unsigned.** `is_mandatory`, `label`, `description`, rollout and *which* package is served all come from the unsigned `update_check` JSON.
  2. **No anti-rollback or replay binding.** The JWT binds only content. There is no app id, deployment, target range, expiry or monotonic counter. A compromised server or CDN can serve **any older validly signed package** (for example one with a known bug) to any device on a matching binary, and it will install.
  3. **Without a public key, full updates are not integrity-checked at all.** `needToVerifyHash` is true only for diffs or when a JWT is present, so TLS is the only protection.
  4. **Signing is optional and opt-in per binary.** Most App Center-era apps never set `CodePushPublicKey` (unverified, but the feature arrived late in CLI 2.1.0 and was not the default).
  5. **Rotation needs a new binary.** It is a single raw public key, with no certificate chain and no `keyid`.
  6. The deployment key is not a secret (it ships in the binary). Anyone can query `update_check` and download packages, so bundles must not contain secrets. (Same for Expo.)

### 7.2 Expo Updates code signing

- **What is signed.** The client sends `expo-expect-signature`. The server returns per-part `expo-signature: sig="…", keyid="…", alg="rsa-v1_5-sha256"`. The signature covers the **exact manifest bytes**, and also directive bodies such as `rollBackToEmbedded`/`noUpdateAvailable`. The manifest pins every asset by SHA-256 (the client MUST verify), so the whole update is covered transitively. Verification is against an embedded certificate (`codeSigningCertificate`, `codeSigningMetadata {keyid, alg}`) ([spec](https://docs.expo.dev/technical-specs/expo-updates-1/), [code signing docs](https://docs.expo.dev/eas-update/code-signing/)).
- **What it adds over CodePush:** signed metadata (`extra`, `runtimeVersion`, `createdAt`); signed rollback directives; `keyid` for rotation.
- **Downgrade resistance.** The client prefers the newest `commitTime`, so replaying an older manifest does not displace a newer one already on the device. Mocco's design builds on this with pre-signed republishes (spec §6.3).
- **Commercial note.** EAS gates signing to the Production/Enterprise plans ([docs](https://docs.expo.dev/eas-update/code-signing/)). Mocco's plan makes it the default.

### 7.3 Known OTA attack classes

- **MITM.** Both clients rely on TLS, and neither pins certificates by default. Without signing, a hostile network with a mis-issued or installed CA can inject JS. Signing closes this for Expo fully and for CodePush except for the gaps above.
- **Compromised storage/CDN or server.** Expo with signing means no forged updates, with limited replay. CodePush with signing means no forged content, but downgrade/replay of old signed packages and flag tampering are possible. CodePush without signing gives full RCE-in-JS on every device.
- **Stolen publisher credentials.** CodePush access keys are long-lived bearer tokens (`access-key add --ttl`) and are the norm in CI. Mocco's OIDC trusted publishing plus approvals mitigates this regardless of wire protocol.
- **Vendor exit or domain lapse.** `codepush.appcenter.ms` is still baked into millions of binaries after the 2025-03-31 retirement. If that domain or another abandoned self-host domain were ever re-registered or taken over, unsigned clients would execute whatever it served. This is a general OTA risk. Custom domains that the customer owns (Mocco foundation) matter.

---

## 8. Recommendation

### 8.1 What CodePush compatibility can and cannot buy

"Change a server URL + deployment key" is only half true. The server URL is **native config only** (§1.2), so:

| Customer situation | What CodePush compat on Mocco gives them |
|---|---|
| **A. Self-hosted `code-push-server` (or a fork) on their own hostname** | **The only zero-store-release migration in the market.** Re-point `codepush.theircorp.com` (DNS/CNAME to a Mocco custom domain) and import the existing deployment key values and package history. Existing installs keep updating. Unique value; nobody else offers it (Codemagic Patch explicitly cannot). |
| **B. App Center refugees still on `codepush.appcenter.ms`** | Nothing for installed binaries (the domain is Microsoft's and dead). They need a new binary anyway. Compat saves only the SDK swap: keep `codePush()` and the JS API, change 2 plist/strings values, and move to `@code-push-next` 10.4+ if on RN ≥ 0.82. |
| **C. Revopush / Codemagic hosted customers** | New binary needed (vendor hostname). Vanilla fields work, but Revopush users would lose byte-diffs (proprietary fields). Weak pull. |
| **D. New apps** | None. Point them at `expo-updates`. |

Segment A is small (self-hosters of an archived server) but high-intent. B is the big group, but for B the real alternative is "one store release plus installing Expo modules", which Expo documents officially. Remember too that these 18 months after the App Center shutdown, most B teams have already moved somewhere (unverified).

### 8.2 Gained and lost if a Mocco app speaks CodePush instead of Expo

- **Gained:**
  - No Expo modules in bare apps.
  - Familiar `sync`/`mandatory`/`targetBinaryVersion` semantics.
  - `update_app_version` store-update hints.
  - Built-in device status reports (`report_status/*`) without Mocco's JS helper.
  - Path A migration.
- **Lost:**
  - A maintained first-party client (you depend on Codemagic's deprioritized fork or on Revopush, a competitor).
  - A public spec.
  - `fingerprint` native-compat safety.
  - Signed metadata and signed rollback directives, so the design goal *"a compromised Mocco DB/store/CDN cannot produce an update a device accepts"* weakens to *"cannot produce new content, but can replay old signed content"*, and only if the app set `CodePushPublicKey`.
  - Per-asset content addressing (CodePush sends a whole zip).
  - bsdiff (file-level diffs only).
  - Emergency launch after a post-`notifyAppReady` crash.
- **Neutral:** channels map to deployments (one key per channel × platform). Percentage rollout, promotion, rollback, disable and governance all map onto Mocco's `ChannelService`/`ApprovalService` unchanged. CodePush `rollback` is simply "serve the previous package", so no pre-signed republish machinery is needed (the JWT inside the zip stays valid).

### 8.3 Effort estimate: CodePush acquisition shim in Mocco's stack

Assumptions: the Expo v1 path (spec) exists first. The shim reuses channels, releases, approvals, audit, `ObjectStore`, `ChannelStateCache` and the metrics tables, and it lives in `packages/backend/src/transport/ext` under `/api/ext/v1/codepush/...`. Hostname binding is through the custom-domains foundation. Estimates are one experienced engineer, **(estimate)**.

| Work item | Effort |
|---|---|
| Hono routes: `GET v0.1/public/codepush/update_check` (+ legacy `/updateCheck`), `POST report_status/deploy`, `POST report_status/download`; snake/camel param parsing; 2-part version normalization | 2 d |
| Pure `selectCodePush(history, request)` porting §1.6 exactly (mandatory stickiness, `update_app_version`, disabled, rollout dual-answer) with a golden test suite ported from MS `acquisition.ts` behaviors | 3 d |
| Data model: `mocco_ota_apps.protocol` (`expo` \| `codepush`); `mocco_ota_codepush_packages` (release_id, platform, label, target_range, package_hash, zip object key, size, diff map jsonb); `mocco_ota_deployment_keys` (hashed key → app/platform/channel; **importable values** for path A) | 2 d |
| Ingest: `mocco-ota publish --protocol codepush` builds the zip (`react-native bundle` + optional `hermesc`), computes the CodePush `packageHash`, optionally signs the `.codepushrelease` JWT in CI, uploads via the existing OIDC upload session; server re-hashes the zip on finalize (`ota.verifyAssets`) | 3–4 d |
| Rollout bucketing: reuse Mocco's deterministic bucket on `client_unique_id` (server-side, so it need not match MS's hash) and label monotonic-cohort semantics | 0.5 d |
| Metrics mapping: `report_status` → `mocco_ota_devices`/daily rollups (active per label, failed = rollback signal, which is *better* telemetry than Expo's emergency-launch) | 1–2 d |
| History import for path A: read a `code-push-server` JSON/Azure/MySQL export (labels, hashes, ranges, blobs) so `package_hash`/`label` lookups resolve for existing installs | 2–3 d |
| Conformance e2e: sample RN 0.8x app with `@code-push-next/react-native-code-push@10.4.x` on emulator (Maestro), signing on and off, rollback watchdog, mandatory | 3 d |
| **Subtotal (acquisition-only shim)** | **about 3–4 engineer-weeks** |
| Optional: file-level diff zips (`hotcodepush.json`) for the previous N packages | +3–4 d |
| Optional: CodePush **management API + `code-push-standalone`/`appcenter` CLI compat** (access keys, 25 routes, multipart release, collaborator model that clashes with Mocco RBAC/approvals) | +3–4 weeks. **Not recommended**: it re-creates long-lived bearer tokens and ungated `promote`/`patch`, which is exactly what Mocco sells against. Offer `mocco-ota` CLI verbs with CodePush names (`release-react`, `promote`, `rollback`, `patch`) instead. |
| Optional: Revopush extension fields (byte diffs) | Do not. Proprietary, moving target, competitor's SDK. |

Hot path cost is similar to the Expo endpoint: one cached history lookup per `(deployment key, app_version, label)` and a JSON response of about 400 B. The `download_url` can be a CDN URL with `immutable` caching. Response caching must vary on the full query minus `client_unique_id` (as MS does), with rollout decided after the cache.

### 8.4 Recommendation

1. **Keep Expo Updates v1 as the primary and default contract** (ADR 1 in the spec stands). Every argument in its favour got stronger: RN 0.82 killed the Microsoft client, Codemagic moved new work off CodePush, and Expo documents the CodePush migration and ships bsdiff and fingerprinting.
2. **Design the v1 domain protocol-agnostic now (cheap).**
   - Put `protocol` on the OTA app.
   - Make a release own per-protocol *artifacts* (Expo updates, or a CodePush package).
   - Make channels, rollouts, approvals, audit and metrics protocol-neutral.
   - Ensure the custom-domain foundation can bind an arbitrary customer hostname *with no path prefix*, because CodePush clients hit `{serverUrl}v0.1/public/codepush/...` at the root.
   - This keeps the door open at near-zero cost.
3. **Ship a CodePush acquisition shim as a v1.x "migration" feature only if design partners in segment A appear.** Scope: 3 endpoints, key and history import, CI signing, `@code-push-next` 10.4+ and legacy 9.0.1 as the supported clients. Market it as *"keep your installed base: point your CodePush hostname at Mocco, then move to `expo-updates` at your next store release"*, with the Mocco console showing both protocols for one app during the transition.
4. **Mark CodePush apps as a lower integrity tier in the UI.** Require `CodePushPublicKey` for protected channels. Warn that metadata is unsigned and that replay of old signed packages is possible. Use the gate to enforce "target range must not include binaries built from a different native fingerprint" (CI can compute the Expo fingerprint even for a CodePush app).
5. **Do not implement the CodePush management API or CLI wire compatibility.** Borrow its vocabulary instead (already the plan in `ota-competitors.md`).

---

## Summary

- The CodePush wire protocol is small and fully documented by archived source: 3 unauthenticated endpoints under `v0.1/public/codepush/`, a zip package with a sorted-manifest SHA-256 `packageHash`, and an optional RS256 JWT (`.codepushrelease`) over that hash.
- Microsoft's client (9.0.1, 2024-12) and server were archived on 2025-05-20. The client doesn't support the New Architecture, so it can't run on RN 0.82+ (where the New Architecture became mandatory, 2025-10-08).
- Two maintained clients use the protocol: `@code-push-next` 10.4.3 (Codemagic, unmodified protocol, about 36K/wk, now deprioritized behind Codemagic Patch) and Revopush 2.6.2 (extended protocol with HDiffPatch, about 8K/wk). The legacy client still has about 24K/wk. `expo-updates` has about 2.7M/wk.
- The self-hosted servers are archived (Microsoft), dormant (lisong, 2019) or lightly maintained (shm-open, last real commit 2024-03).
- Compared with Expo, CodePush lacks fingerprint targeting, signed metadata, anti-replay, per-asset addressing and bsdiff. It has sticky `mandatory`, store-update hints and built-in status reports.
- The server URL can't be changed from JS, so "swap URL + key" still means a store release, except for teams already on a CodePush hostname they control. For them, a Mocco shim is the only zero-store-release migration on the market.
- Recommendation: stay Expo-first, keep the domain protocol-agnostic, and build an acquisition-only CodePush shim (about 3–4 engineer-weeks) only when segment-A design partners appear. Skip the management API and CLI compatibility.
