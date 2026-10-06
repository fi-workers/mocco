# @mocco/sdk-core

## 0.4.0

### Minor Changes

- 3f4d603: `HelpClient.sendFeedback(id, { helpful, locale?, comment? })` answers "Was this helpful?" for a published article. Pass a `visitorId` the app keeps (such as an install id) to `createHelp` so Mocco counts one answer per reader, article and day; without one the client makes a random id for its own lifetime. Mocco stores only a hash of it.
- b010c94: `HelpClient` reads a project's published help center as well as searching it: `getSite` (name, languages and the collections → sections → articles), `getCollection(slug)` and `getArticle(id)`, each in the reader's language where translated, with `locale` on the answer saying which was served. `getArticle` and `getCollection` answer `null` for what isn't published. `@mocco/js` exports `createHelp` and `HelpClient`; `@mocco/react-native/messenger` exports the new types.
- a358655: Messenger attachments can be PDFs: `MessengerClient.attach` takes `contentType: 'application/pdf'` (up to 10 MB, like screenshots), and every served attachment carries its `filename`. A PDF's `url` is a download link, never one to open in a browser tab. The bytes must be the declared type, or the message that carries them is refused.
- 29a7b09: `heartbeat(token).wrap(fn)` pings a Mocco heartbeat monitor around a job: `/start` before `fn`, then success, or `/fail` when `fn` throws (its error is rethrown), and returns `fn`'s result. `success()`, `start()`, `fail()` and `exitCode(code)` send one ping. A ping never throws: a network error, a timeout or a refusal is retried once (except a 404, a wrong token) and then reported to `onError`, a console warning by default, so monitoring never breaks the job. No API key is sent; the `mhb_` token in the path is the credential. Self-hosted installs pass `baseUrl`.
- 1b64c71: `StatusMaintenance` now has `runId`, `overranAt` and `endNote`: the run whose resumed gate started the window (null for a window an operator scheduled), when it was still in progress past its expected end, and why it ended early when the run failed, was canceled or was rejected.
- b967209: `createMoccoServer({ secretKey })` now has `status`, the project's status page as code over the `/v1` status API (`StatusClient`, on the new `@mocco/sdk-core/status` subpath so browser bundles don't carry it). `status.monitors.upsert(key, input)` creates the monitor with that key or changes it to match, and answers `unchanged` without changing anything when it already does, so CI can run it on every deploy; a new heartbeat's ping token is in the answer that creates it. Also `monitors.list`, `get`, `pause`, `resume`, `delete` and `check`; `incidents.list`, `get`, `create`, `update` and `setComponents`; `maintenances.list`, `schedule` (times as `Date`s or ISO strings) and `cancel`; `pages.list`; `components.list` and `setStatus`; and `locations.list` and `idsOf(codes)` for a monitor's `locationIds`. The key needs `status:read` to read and `status:write` to change; a refusal is a `MoccoError` with its `code`. `MoccoClient` now retries a `PUT` on 429 and 5xx, like a GET.

## 0.3.0

### Minor Changes

- 7e7c786: Help center search for apps: `HelpClient.search(query, { locale, limit })` returns the project's published help articles (with `title`, `url` and a `snippet`), for a key with the new `help:read` scope. In React Native, `createHelp` and `useHelpSearch(help, query)` (from `@mocco/react-native/messenger`) search as the user types, for example to suggest articles on a contact screen. `match: 'any'` finds articles sharing any word with free text, such as an inquiry being written.

## 0.2.0

### Minor Changes

- cd49729: `MessengerClient.deleteMyData()`: erase everything the user wrote (conversations, messages, screenshots) in Mocco and forget them on the device, for an app's "delete my account".

## 0.1.0

### Minor Changes

- 9cd21f2: Feature flags for servers: `@mocco/flags-core` evaluates Mocco's flagd-compatible rulesets locally (the restricted JsonLogic subset, `fractional` bucketing, `sem_ver`), and `@mocco/openfeature-server` is an OpenFeature server provider that polls the key's ruleset with ETags and keeps serving the last good one when Mocco is unreachable. `MoccoClient.getIfChanged()` adds conditional GETs.
- 8201753: `@mocco/openfeature-server` listens to Mocco's change stream and fetches the ruleset as soon as it changes (`changeDetection: 'stream'`, the default; `'poll'` polls only). `@mocco/sdk-core` gains `MoccoClient.openStream()` and `readServerSentEvents()`.
- 19bb610: The flag providers send Mocco how often each flag was read, counted in memory and sent at most once a minute (`telemetry: false` turns it off). Mocco uses the counts only to point out flags that look ready to remove. `@mocco/sdk-core` gains `EvaluationCounter`.
- 5a8f153: First release of Mocco's SDKs: the shared /v1 client (`@mocco/sdk-core`), the browser SDK (`@mocco/js`), the server SDK with `signIdentity()` and `verifyWebhook()` (`@mocco/node`), the React Native SDK with hosted OTA updates and its Expo config plugin (`@mocco/react-native`), and the `mocco-ota` CLI (`@mocco/ota-cli`).
- 8ad5fb9: Messenger attachments: `MessengerClient.attach()` uploads a screenshot and returns its id for `startConversation` / `sendMessage` (and `useConversation().send(body, attachmentIds)`); messages carry `attachments` with short-lived download links.
- a018af6: Messenger guests: `MessengerClient.continueAsGuest({ email, name? })` lets someone who isn't signed in write (when the app allows guests). The device keeps the guest, and signing in later moves what they wrote to their account. `MessengerState.isGuest` tells which you have.
- 914ddb2: Messenger reply push: `MessengerClient.registerPushToken()` registers the device's Expo push token (removed again on `signOut()`), and `messengerConversationIdOf(data)` reads the conversation a notification is about.
- b99b71b: `MessengerClient.reidentify()`: call it when someone signs in to the app. The messenger asks `identity` again and opens their session; what the device wrote as a guest moves to the account, and a registered push token follows. `@mocco/react-native/messenger` also exports `MoccoError` and `MoccoNetworkError`, so an app can tell a refusal (such as `guests_not_allowed`) from a network failure. The stored session is kept per publishable key, so a build with another key (another project) doesn't reuse it.
- bc9caf8: In-app contact with Mocco Messenger. `@mocco/sdk-core` gains `MessengerClient`, a headless client for a signed-in user's conversations with your team. `@mocco/react-native/messenger` adds `createMessenger`, `<MessengerProvider>` and the hooks `useConversations`, `useConversation`, `useUnreadCount` and `useMessengerCategories`, so your app draws the screens in its own design. `expo-updates` is now an optional peer: only `@mocco/react-native/ota` needs it.
