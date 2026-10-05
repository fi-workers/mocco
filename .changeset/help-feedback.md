---
'@mocco/sdk-core': minor
'@mocco/js': minor
'@mocco/react-native': minor
---

`HelpClient.sendFeedback(id, { helpful, locale?, comment? })` answers "Was this helpful?" for a published article. Pass a `visitorId` the app keeps (such as an install id) to `createHelp` so Mocco counts one answer per reader, article and day; without one the client makes a random id for its own lifetime. Mocco stores only a hash of it.
