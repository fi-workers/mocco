---
'@mocco/sdk-core': minor
'@mocco/js': minor
'@mocco/react-native': minor
---

A feedback sheet for a board's ideas. `@mocco/js/feedback-sheet`: `createFeedbackSheet({ publishableKey, board, endUserToken? }).mount(button)` opens a side sheet with the most voted ideas, vote buttons, and a box to post an idea that suggests similar ones while the user types. `@mocco/react-native/feedback`: `createFeedbackSheet`, `<FeedbackSheet sheet visible onClose />` (a modal page sheet) and `useFeedbackSheet(sheet)` to draw your own. Without a signed-in user the sheet is read-only. `FeedbackClient` also gains `board(slug).similar(title)`, `board(slug).createPost(input)`, `board(slug).roadmap()`, `comments(postId)`, `comment(postId, body)`, `follow(postId)` and `unfollow(postId)`. In `@mocco/sdk-core`: `FeedbackSheetModel` on `@mocco/sdk-core/feedback-sheet`.
