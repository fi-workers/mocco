---
title: Connect Mocco to your agent
description: Add Mocco's MCP server to Claude Code, Claude Desktop, Cursor, VS Code or any MCP client — what it can see, what it can do, what it will never do, and how to turn the deciding tools on.
type: guide
status: draft
created: 2026-10-02
updated: 2026-10-02
confidence: medium
owner: andrea
tags: [customer, mcp, agents, setup]
related:
  - ../../adr/0025-every-product-surface-ships-mcp-tools.md
  - ../../specs/2026-10-02-mcp-and-cli-design.md
---

# Connect Mocco to your agent

Mocco speaks the Model Context Protocol, so the assistant you already code with can
answer "is the deploy stuck, and on what?" without you leaving the terminal.

The server is **remote and hosted by us** — nothing to install, nothing to keep updated.
You sign in once in the browser and the client holds the token.

```
https://www.mocco.club/api/mcp
```

> Not shipped yet. This page is the shape it will take; the slices are in the
> [design spec](../../specs/2026-10-02-mcp-and-cli-design.md).

## What it can do

**It reads as you.** You see what your Mocco roles let you see, in whichever workspaces
you belong to — never more, because the server has no privileges of its own.

| | |
|---|---|
| Runs | Which are running, which are waiting, which failed, and on what |
| Gates | Why a run is paused and what would release it |
| Approvals | What is waiting on a human, on whom, and who has voted |

**Deciding is separate and off by default.** Approving, resuming and promoting are
switched on per workspace by an owner. Until then your agent can tell you the deploy is
blocked on a second approval; it cannot be that approval.

When they are on, each one asks you to confirm — the client shows you the run, the gate
and the policy before anything happens. That confirmation is the protocol's own step, not
a prompt we wrote, and it is what stops a page of text your agent read somewhere from
turning into a production deploy.

## What it will never do

- **Act as anyone but you.** Every action goes through the same check the console does,
  with your identity. An agent cannot approve what you could not approve.
- **Accept an API key for a decision.** A key is a project, not a person, and an approval
  has to name someone who could have been asked. Keys get the read tools.
- **Hide anything from the audit trail.** A vote cast through an agent appears in the
  chain exactly like one cast in the console, naming you.

## Add it

### Claude Code

```bash
claude mcp add --transport http mocco https://www.mocco.club/api/mcp
```

Then run `/mcp` and pick **mocco** to sign in. Check it took with:

```bash
claude mcp list
```

### Claude Desktop and claude.ai

**Settings → Connectors → Add custom connector**, and paste the URL above. The browser
sign-in happens inline.

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "mocco": {
      "url": "https://www.mocco.club/api/mcp"
    }
  }
}
```

Cursor opens the browser for sign-in by itself. Leave out any headers — this server uses
OAuth, not a token you paste.

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "mocco": {
      "type": "http",
      "url": "https://www.mocco.club/api/mcp"
    }
  }
}
```

VS Code runs the OAuth flow itself, so there is nothing to put in `headers` or `inputs`.

### Anything else

Any client on the **2026-07-28** MCP revision works: point it at the URL and let it
discover the rest. The server publishes its protected-resource metadata at
`/.well-known/oauth-protected-resource`, so a conforming client finds the authorization
server without being told.

It serves that revision only, over `POST`. A client still on the older HTTP+SSE transport
will not connect — upgrade it, or use the `mocco` CLI in the meantime.

## Turning the deciding tools on

An owner or admin enables them per workspace: **Settings → Agents → Allow agents to
decide**. Switching it on records who did, and every tool it unlocks is still bound by the
roles of whoever calls it.

Leave it off for workspaces where an agent only needs to report. That is most of them.

## If it will not connect

| What you see | What it means |
|---|---|
| The client asks for a token or header | It is treating this as a key-authenticated server. Remove the header; this one is OAuth |
| `405 Method Not Allowed` on connect | The client is trying `GET` or `DELETE`. It is on the old transport — upgrade it |
| Sign-in succeeds, tools are missing | The deciding tools are off for that workspace, or your roles do not include them |
| Tools from the wrong workspace | You belong to several. Ask the agent to switch workspace, or pin one in the client config |
