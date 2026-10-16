# block-editor (vendored)

editorcn's block editor, from [shadcn-labs/editorcn](https://github.com/shadcn-labs/editorcn) (MIT),
copied from its shadcn registry (`https://www.rtecn.space/r/block-editor.json`) for the help article
editor (#486). It keeps upstream's formatting, so lint and prettier skip this directory; TypeScript
still checks it.

Changed from upstream, so everything the editor can make is something Markdown can hold:

- removed the color and highlight selector, the text alignment selector and the color swatch
- removed underline from the bubble menu's text buttons
- removed the task list from the slash menu and the node selector

To update: fetch the registry JSON again, write its files here, and re-apply the list above.
