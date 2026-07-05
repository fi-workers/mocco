#!/bin/sh
# Migration drift check — schema.ts must match the committed migrations.
# Single source of truth for CI and local (`yarn ci:drift` runs this).
set -eu

# stdin closed: an ambiguous rename would otherwise prompt and hang until timeout
yarn db:generate < /dev/null

drift="$(git status --porcelain src/backend/db/migrations)"
if [ -n "$drift" ]; then
  echo "::error::drizzle migrations out of sync with schema.ts — run 'yarn db:generate' and commit the result" >&2
  echo "$drift" >&2
  exit 1
fi
