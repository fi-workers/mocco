# Web example: "what's new" and the feedback sheet

A static page with two buttons: **What's new** (the unread badge and the newest changelog entries, `@mocco/js/whats-new`) and **Ideas** (the feedback sheet, `@mocco/js/feedback-sheet`). `server.mjs` serves it and signs the end-user token for a demo user, `user-42`, the way your server signs one for its signed-in user. A checkbox on the page signs that user in and out.

The guide is [Collect ideas in your app](../../docs/customer/feedback/in-app-ideas.md).

## Run it

You need Node 22, a project with a public feedback board, and from Mocco:

- a publishable key with `feedback:read` and `feedback:write`;
- `http://localhost:4315` as a web origin of the project's web app (**Settings → Apps**);
- the project's identity secret (the one Messenger setup shows; see [In-app contact](../../docs/customer/messenger/contact-us.md)).

Build the SDKs once from the repository root, then start the server:

```bash
yarn install && yarn sdk:build

cd examples/web-feedback
MOCCO_PUBLISHABLE_KEY=mk_pub_… \
MOCCO_IDENTITY_SECRET=… \
MOCCO_BOARD=ideas \
node server.mjs
```

Open http://localhost:4315. `MOCCO_API_URL` points the page at another Mocco, such as a local one (`http://localhost:3100/api/ext/v1`); leave it out for Mocco's API. `PORT` changes the port (then register that origin instead).

The page loads the SDK's built files through an import map. In your app, install `@mocco/js` and import the same names; a bundler needs no import map.
