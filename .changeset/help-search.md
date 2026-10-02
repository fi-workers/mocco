---
'@mocco/sdk-core': minor
'@mocco/react-native': minor
---

Help center search for apps: `HelpClient.search(query, { locale, limit })` returns the project's published help articles (with `title`, `url` and a `snippet`), for a key with the new `help:read` scope. In React Native, `createHelp` and `useHelpSearch(help, query)` (from `@mocco/react-native/messenger`) search as the user types, for example to suggest articles on a contact screen.
