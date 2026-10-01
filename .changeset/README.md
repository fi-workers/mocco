# Changesets

The published SDK packages (`@mocco/sdk-core`, `@mocco/js`, `@mocco/node`, `@mocco/react-native`, `@mocco/ota-cli`) are versioned with [changesets](https://github.com/changesets/changesets). Run `yarn changeset` in a PR that changes one of them; merging to `main` opens a "Version packages" PR, and merging that publishes with npm trusted publishing and provenance (`.github/workflows/publish.yml`). The app packages are private and ignored.
