---
title: Connect Mocco to your agent
description: Add Mocco's MCP server to Claude Code, Claude Desktop, Cursor, VS Code or any MCP client — what it can see, what it can do, what it will never do, and how to turn the deciding tools on.
type: guide
status: draft
created: 2026-10-02
updated: 2026-10-05
confidence: high
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

> The read tools are in, and so is the first deciding tool: voting on an approval request.
> Resuming a paused run comes next, then promoting. The plan is in the
> [design spec](../../specs/2026-10-02-mcp-and-cli-design.md).

## What it can do

**It reads as you.** You see what your Mocco roles let you see, in whichever workspaces
you belong to — never more, because the server has no privileges of its own.

| Tool | Answers |
|---|---|
| `mocco_runs_search` | Which runs are running, waiting or failed. Filter by `awaiting_gate` for "what is blocked" |
| `mocco_runs_get` | One run: its steps, and the gate holding it with what would release it |
| `mocco_approvals_search` | What is waiting on a human right now |
| `mocco_approvals_get` | One request: the change it pins, the requirements, and the votes so far |

Reads take a `responseFormat`: `concise` by default, `detailed` when the agent wants the
commit and the gate requirements too. That keeps a search from spending your context on
rows you did not ask about.

**Which workspace?** If you belong to one, say nothing. If you belong to several, the
tool asks which and names them — and a workspace you are not a member of is refused
whether or not it exists.

**Deciding is separate and off by default.**

| Tool | Does |
|---|---|
| `mocco_approvals_vote` | Approves or rejects a pending request as you, with an optional reason |

Deciding is switched on per workspace by an owner or admin (below). Until then your agent
can tell you a change is waiting on a second approval; it cannot be that approval.

When it is on, every vote asks you first. Your client shows what is about to happen — approve
or reject, the kind of request, what it is about, the exact change it would let through, and
your reason — and nothing is voted until you answer yes. Declining, or closing the prompt,
votes nothing. That confirmation is the protocol's own step, not a prompt we wrote, and it
is what stops a page of text your agent read somewhere from turning into a production
deploy. A confirmation is good for five minutes and only for the vote it showed: change the
decision or the reason and you are asked again.

The vote is then cast exactly as if you had clicked it in the console. The request's own
rules still apply: you need one of the roles it asks for, you cannot approve a change you
requested when the request forbids it, and you get one vote.

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
discover the rest. An unauthenticated call is answered with a `401` that points to the
protected-resource metadata at `/.well-known/oauth-protected-resource/api/mcp`, which names
the authorization server; its own metadata is at
`/.well-known/oauth-authorization-server/api/auth`. A conforming client follows both
without being told.

It serves that revision only, over `POST`. A client still on the older HTTP+SSE transport
will not connect — upgrade it, or use the `mocco` CLI in the meantime.

## Approving the connection

The first time a client connects, your browser opens Mocco. Sign in if you aren't already,
and Mocco asks whether to let that app read as you:

![The consent screen: the app's name, the account it would act as, what it will be able to do, and Allow or Deny](./images/mcp-consent.png)

**Allow** sends you back to the client, which finishes connecting by itself. **Deny** tells
the client you said no, and it gets nothing. Once you allow an app, Mocco remembers, so
reconnecting it later doesn't ask again.

Only allow an app you just started connecting. If this screen appears and you didn't start
anything, choose Deny.

### Allowing an app to vote

Connecting does not let an app vote. The first time your agent tries to, Mocco answers that
the connection needs one more permission, and your client opens the same screen again with
one new line: **Approve or reject changes as you, in workspaces that allow agents to
decide**. Allow it and the client carries on with the vote, which still asks you to confirm
it. Deny it and the app keeps reading, as before.

You are asked once per app. The permission does nothing in a workspace that has not allowed
agents to decide, and nothing beyond what your roles allow anywhere.

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
| "Agents may not vote in this workspace" | Deciding is off for that workspace. An owner or admin can turn it on in **Settings → Agents** |
| "This connection may not vote" | The app was never allowed to vote. Reconnect it and allow the voting permission when asked |
| "not in a role authorized to approve" | Your roles do not cover this request. Someone in one of the roles `mocco_approvals_get` lists has to vote |
| The browser reports an invalid scope when you allow voting | The app was connected before voting existed, and Mocco has not yet refreshed what it may ask for. It does within the hour; try again then |
| The browser opens Mocco's sign-in and then lands on your workspaces instead of the client | The page was opened without the client's request in its address. Start the connection again from the client |
| Tools from the wrong workspace | You belong to several. Ask the agent to switch workspace, or pin one in the client config |
