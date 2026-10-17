---
'@mocco/sdk-core': minor
'@mocco/js': minor
'@mocco/react-native': minor
---

"What's new" for a feedback board's changelog. `@mocco/js/whats-new`: `createWhatsNew({ publishableKey, board, endUserToken? })` with `unreadCount()`, `markSeen()` and `mount(button)`, which puts an unread badge on the button and opens the newest entries in a popover (marking them seen). `@mocco/react-native/whats-new`: `createWhatsNew`, `useWhatsNew(whatsNew)` and `<WhatsNewBadge whatsNew />`. A signed-in user's read mark is kept by Mocco (pass `endUserToken`, a function returning the token your server signs); a visitor's is kept on the device (localStorage, or the `storage` you pass). `@mocco/js/feedback` (`createFeedback`) and `FeedbackClient` read a board's posts and changelog and vote as the signed-in user. In `@mocco/sdk-core`: `FeedbackClient` on `@mocco/sdk-core/feedback` and `WhatsNew` on `@mocco/sdk-core/whats-new`.
