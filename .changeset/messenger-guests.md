---
'@mocco/sdk-core': minor
'@mocco/react-native': minor
---

Messenger guests: `MessengerClient.continueAsGuest({ email, name? })` lets someone who isn't signed in write (when the app allows guests). The device keeps the guest, and signing in later moves what they wrote to their account. `MessengerState.isGuest` tells which you have.
