---
title: Mocco events
description: The events Mocco produces on its own for deploy governance (runs and gates), what each message shows, their filter keys, and the Mocco preset.
type: guide
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
tags: [customer, notifications, events, governance, guide]
related:
  - ./overview.md
  - ./connect-discord.md
---

# Mocco events

Besides forwarding Sentry, Vercel and GitHub, Mocco posts its own deploy governance events. They
need no source: add a rule to a channel and they start arriving.

| Event | When | The message shows |
|---|---|---|
| `gate.pending` | A run reached a gate and waits for approval. | Repository, pipeline, short commit, who triggered the run, the gate, and what it needs (for example "2 × deployer"), with a link to the run. |
| `gate.resumed` | Someone with the right role resumed the gate. | The same run details and the roles that resumed it. |
| `gate.rejected` | Someone rejected the gate. | The same run details and the reason given. |
| `run.failed` | A run failed. | The run details, the step that failed and a link to its logs, when known. |
| `run.succeeded` | A run finished successfully. | The run details. |

Every message links back to the run in Mocco.

## The Mocco preset

On a channel's **Rules**, choose the **Mocco** preset and click **Apply**. It adds `gate.pending`,
`gate.resumed`, `gate.rejected` and `run.failed`. It leaves out `run.succeeded`, which is often
noisy; add it by hand if you want it. You can also use `gate.*` or `run.*` to get a whole family.

Mocco events never come from a source, so a rule limited with **Only from source** never matches
them.

## Filter keys

| Event | Keys |
|---|---|
| `run.*` | `repo` (`acme/web`), `pipeline` (the `pipeline` name in `.mocco.yml`) |
| `gate.*` | `repo`, `pipeline`, `gate` (the gate's name) |

For example, to send only production approvals to `#deploys`, add a rule on `gate.pending` with
the filter `gate=production`.

## In Activity

Mocco events appear in the **Activity** tab with the source **Mocco** when at least one channel got
a message for them. Their details show the delivery to each channel, the same as for events from a
source. See [Troubleshooting](./troubleshooting.md) for what each status means.
