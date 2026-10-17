---
title: GitHub App permissions and events
description: The repository permissions and webhook events Mocco's GitHub App needs, which feature uses each, what changed for feedback links (#178), and how existing installations accept a permission change.
type: reference
status: active
created: 2026-10-17
updated: 2026-10-17
confidence: medium
owner: andrea
tags: [reference, github, integration, permissions, webhooks]
related:
  - ./feedback.md
  - ./flags.md
  - ../specs/2026-09-24-feedback-design.md
code_refs:
  - packages/backend/src/domain/integration/github/provider.ts
  - packages/backend/src/domain/integration/github/constants.ts
  - packages/backend/src/domain/integration/github/webhook-events.ts
  - packages/backend/src/domain/integration/CommitSyncService.ts
---

# GitHub App permissions and events

Mocco reaches GitHub only through its GitHub App (`domain/integration/github/provider.ts`, the one file that imports octokit). An installation token can do only what the App's settings grant, so every feature that reads or writes something new on GitHub needs the matching permission there, and every webhook it reacts to needs the event subscription. This page lists both, by the API calls the code makes. The App's settings live on GitHub (Settings → Developer settings → GitHub Apps → the Mocco App → Permissions & events); this repo can't change them, so a slice that needs more says so here and in its PR.

Confidence is medium: the list is derived from the calls in `provider.ts`, not read back from the live App.

## Repository permissions

| Permission | Access | Used by |
|---|---|---|
| Metadata | Read | Required by GitHub for every App; `GET /installation/repositories` (connecting repos) |
| Contents | Read and write | Read: commit history (`GET /repos/{owner}/{repo}/commits`), `.mocco.yml` and `.mocco/flags.yml` at a commit (`GET …/contents/{path}`), the code archive for the flags deploy check (`GET …/tarball/{ref}`), whether a release contains a feedback post's merged pull request (`GET …/compare/{base}...{head}`, #179). Write: `repository_dispatch` (`POST …/dispatches`), which starts a GitHub Actions run for a pipeline step |
| Checks | Read and write | The flags plan check on a pull request (`POST …/check-runs`, #146) |
| Pull requests | Read | `pull_request` webhooks (flags plan check, #146; feedback links, #178), and reading a linked pull request (`GET …/pulls/{number}`) and the pull requests that close a linked issue (GraphQL `closedByPullRequestsReferences`) |
| Issues | Read | **New for feedback links (#178).** Reading a linked issue (`GET …/issues/{number}`), searching issues and pull requests in a repo (`GET /search/issues`, always scoped with `repo:owner/name`), and `issues` webhooks |

## Webhook events

The App's webhook URL is `/api/ext/github/webhook` (verified with `GITHUB_WEBHOOK_SECRET`, deduplicated by delivery id, processed after the 202 in a deferred pass). `installation` and `installation_repositories` are delivered to every App without a subscription.

| Event | Used by |
|---|---|
| `push` | Commit sync for watched branches; `.mocco/flags.yml` sync on the default branch (#145) |
| `pull_request` | The flags plan check (`opened`, `synchronize`, `reopened` into the default branch, #146); every action updates feedback links to that pull request and the closers of linked issues (#178) |
| `issues` | **New for feedback links (#178).** Every action updates links to that issue; a change of state (closed, reopened) resolves its closing pull requests again |

An event for a repo no workspace registered, or for an installation no workspace connected, is parked: logged and dropped. The repo is always resolved through the installation's connection (`installation_id → connection → repo by (connection_id, external_repo_id)`), never by GitHub's repo id alone.

## Changing the App's permissions

Adding a permission or an event to the App doesn't reach existing installations by itself:

1. In the App's settings, add the permission (for #178: **Issues: Read-only**; make sure **Pull requests: Read-only** is on) and the event subscription (**Issues**; make sure **Pull request** is on), then save. GitHub asks for a note to show installers.
2. Each organization or account that installed the App gets an email and a banner on its installation page (Settings → GitHub Apps → Mocco → **Review request**). Until an owner accepts, its installation keeps the old permissions: Mocco's calls that need the new one fail (searching and linking issues answers an error) and GitHub doesn't deliver the new events for its repos.
3. Accepting delivers `installation` with action `new_permissions_accepted`. Mocco parses it and changes nothing; the next call simply succeeds.

Deliveries GitHub never sent (an outage, or changes made before an installation accepted) are caught up by the feedback link refresh job (`feedback.links.refresh`, every 10 minutes; [feedback links](./feedback.md#github-links)).
