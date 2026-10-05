---
'@mocco/sdk-core': minor
'@mocco/react-native': minor
---

Messenger attachments can be PDFs: `MessengerClient.attach` takes `contentType: 'application/pdf'` (up to 10 MB, like screenshots), and every served attachment carries its `filename`. A PDF's `url` is a download link, never one to open in a browser tab. The bytes must be the declared type, or the message that carries them is refused.
