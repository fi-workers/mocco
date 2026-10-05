---
'@mocco/sdk-core': minor
'@mocco/js': minor
'@mocco/react-native': minor
---

`HelpClient` reads a project's published help center as well as searching it: `getSite` (name, languages and the collections → sections → articles), `getCollection(slug)` and `getArticle(id)`, each in the reader's language where translated, with `locale` on the answer saying which was served. `getArticle` and `getCollection` answer `null` for what isn't published. `@mocco/js` exports `createHelp` and `HelpClient`; `@mocco/react-native/messenger` exports the new types.
