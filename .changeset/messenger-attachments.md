---
'@mocco/sdk-core': minor
'@mocco/react-native': minor
---

Messenger attachments: `MessengerClient.attach()` uploads a screenshot and returns its id for `startConversation` / `sendMessage` (and `useConversation().send(body, attachmentIds)`); messages carry `attachments` with short-lived download links.
