---
title: Every product surface ships MCP tools
description: MCP is a first-class surface alongside the console and /v1, not a later integration — every product slice that adds a capability also adds its tools, and the tools are thin adapters over the same services with the caller's own identity.
type: adr
status: draft
created: 2026-10-02
updated: 2026-10-02
confidence: high
owner: andrea
decision_date: 2026-10-02
stakeholders: [andrea]
tags: [adr, mcp, api, agents, governance, security]
related:
  - ./0002-mocco-is-an-independent-authorization-layer.md
  - ./0011-external-api-surface-architecture.md
  - ./0013-mocco-is-a-multi-product-platform.md
  - ./0017-public-v1-api-keys-and-sdk-licensing.md
  - ../specs/2026-10-02-mcp-and-cli-design.md
---

# ADR 0025 — Every product surface ships MCP tools

## Context

Mocco's buyer is a developer, and that developer increasingly works through an agent. The
agent already opens the pull request, watches CI and asks to deploy. The one thing it
cannot do is see or act on the governance that decides whether the deploy happens — the
console is tRPC-only and `/v1` covers only the products whose SDKs needed it.

Every competitor category we researched has converged on this in the same eighteen
months: flags, feedback, reviews, help centre, forum and deep-link vendors all shipped MCP
servers, and the research pages in this repository already record it as table stakes
rather than differentiation. A product a developer's agent cannot reach is a product the
developer has to leave their tools to use.

The risk of adding it late is worse than the cost of adding it early. Retrofitting an
agent surface onto services that were written assuming a browser session is where the
confused-deputy bugs come from: the shortcut is to let the server act with its own
privileges, and by then there is a console, an API and a CLI whose shapes all have to be
reconciled.

## Decision

1. **MCP is a first-class surface, decided per slice, not per quarter.** A slice that adds
   a capability adds its MCP tools in the same slice or in the one immediately after it,
   and says which in its spec. "We'll add MCP later" is not an acceptable plan for a new
   product line.

2. **A tool is a thin adapter over one service**, exactly as a tRPC router is. It parses
   its input, calls one domain service, and maps that domain's errors to a message a model
   can act on. No tool composes a decision across services, and no tool has a code path
   the console does not have. If an agent can do something through MCP that a person
   cannot do in the console, that is a hole in the model, not a feature of MCP.

3. **A tool acts as the caller, never as the server.** Every tool passes the
   authenticated person's id into the service and lets that service's role check decide.
   The MCP server holds no privilege of its own. This is what keeps it from being the
   confused deputy that MCP's security literature puts at the centre of the protocol, and
   it is a restatement of [ADR 0002](./0002-mocco-is-an-independent-authorization-layer.md):
   authorization is Mocco's, and it is attached to a person.

4. **Reads may be a key; decisions may not.** An API key authenticates a project and can
   be given read tools. Anything that approves, resumes, promotes or deploys requires a
   person's token, because the audit chain must name someone who could have been asked.

5. **Mutating tools are off unless a workspace turns them on**, and confirm through the
   protocol's own round trip before they act. Prompt injection succeeds when a tool call
   executes silently; the default for a surface that can reach production is the safe one.

6. **Tools are searchable, not enumerable.** A read tool takes filters and paging and
   offers a concise and a detailed shape. A tool that returns everything makes the model
   pay for every row before it finds the one it wanted.

7. **Tools are named `mocco_<domain>_<verb>`**, so they stay legible in a client that has
   several servers loaded, and so a new product line cannot collide with an existing one.

8. **Every mutating tool is audited through the same service that audits the console.**
   The audit chain must not be able to tell a browser from an agent except by the
   principal it records.

## Consequences

- A new product line's definition of done includes its tools. The feature map and each
  spec carry them.
- The domain services stay the single source of business rules; three transports (tRPC,
  `/v1`, MCP) and the CLI are all thin over them. A rule fixed once is fixed everywhere.
- Shipping a capability costs slightly more up front. That cost is the tool file and its
  tests, against the alternative of a second authorization path discovered later.
- Some capabilities will have read tools long before deciding tools. That asymmetry is the
  decision working, not a gap to close.
- Install documentation is part of the product: a surface nobody can connect to is not
  shipped. See [Connect Mocco to your agent](../customer/mcp/connect.md).

## Reversal condition

If the protocol's churn makes per-slice tools more expensive than the reach they buy — for
example another breaking revision inside a year that invalidates the tool shape — fall back
to shipping tools per product line at the end of each line rather than per slice. The thin
adapter rule and the caller-identity rule do not reverse: those are security properties,
not convenience.
