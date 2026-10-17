---
'@mocco/sdk-core': minor
'@mocco/js': patch
'@mocco/react-native': patch
---

The feedback sheets show **Voted** on the ideas a signed-in user voted for before, as soon as they open. `FeedbackPost` gains `viewerVote` (the signed-in end user's own vote: `'counted'`, `'pending'` or null; absent for a visitor), which `board(slug).posts()`, `roadmap()` and `similar()` now read with the end-user token. A read whose `endUserToken` function throws goes as an anonymous visitor instead of failing.
