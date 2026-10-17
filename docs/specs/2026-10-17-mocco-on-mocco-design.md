---
title: Mocco on Mocco — running Mocco's own support, feedback and releases on Mocco
description: Which Mocco products Mocco itself uses for its own users, where they are served (subpaths of www.mocco.club, for search and one brand), the proposed split of the console onto app.mocco.club, the order to turn each part on, and what each step needs — the feedback board and changelog, the console's own What's new badge and feedback sheet, email, the status page, and shipping posts from Mocco's own releases.
type: spec
status: draft
created: 2026-10-17
updated: 2026-10-17
confidence: medium
owner: andrea
tags: [spec, design, dogfooding, domains, seo, helpcenter, feedback, changelog, status-page, email]
phase: design
implements: ../adr/0029-mocco-is-everything-a-product-needs-except-the-code.md
related:
  - ../adr/0015-public-sites-use-isr-on-the-pages-router.md
  - ../adr/0028-status-pages-are-static-snapshots.md
  - ../reference/env.md
  - ../reference/storage.md
  - ./2026-09-24-feedback-design.md
---

# Mocco on Mocco

Mocco is "everything a product needs except the code" ([ADR 0029](../adr/0029-mocco-is-everything-a-product-needs-except-the-code.md)).
Mocco is also a product with users, so it should run its own feedback board, changelog, help, status page and support
on itself. This finds the gaps a customer would hit, and gives the team one place for what users ask.

This spec decides where those live, the order, and who does each step.

## Where things stand (2026-10-17)

- The app is `www.mocco.club` on Vercel (project `mocco`); `mocco.club` redirects to it. DNS is on Cloudflare.
- `www.mocco.club` serves both the public pages (the landing page, `/docs` from the repo) and the console
  (`/workspaces/…`, `/auth/…`, `/account`).
- Production has no `HELP_SITES_DOMAIN`, no email (`EMAIL_*` unset, no MX or sending records) and no
  `AI_GATEWAY_API_KEY`. So no help site is served in production, no mail goes out (votes by email, status mail,
  status subscribers) and duplicate detection stays on title words.
- Object storage is the `fi-workers-mocco-storage` S3 bucket with no CDN ([storage](../reference/storage.md)).
- The feedback stack (console, changelog, duplicates, intake, GitHub links, ship suggestions, SDK widgets) is in open
  PRs; production has only the public board and post pages.

## Decision: Mocco's public pages are subpaths of one domain

Mocco's own feedback board, roadmap and changelog are served at `www.mocco.club/feedback/<board>` (and
`…/roadmap`, `…/changelog`, `…/changelog.rss`), beside `/docs`, not on a `help.` subdomain.

- **Search.** One host collects the links and authority of everything public: the landing page, docs, changelog and
  board. A subdomain is treated as a separate site and starts from nothing.
- **It fits the routes as they are.** Board pages already live under `/feedback/…` on a site's host, and nothing on
  `www.mocco.club` uses `/feedback`. So the app host mounts one site (`mocco`) at that prefix with the same pages and
  links; only the origin used for canonical URLs, the sitemap, the feed and mail links changes for that site.
- **Docs stay at `/docs`.** They ship with the code they describe, from the repo. Mirroring them into the help center
  (search, translations, in-app suggestions) needs a sync on each deploy so the two never drift; until then Mocco's
  help center holds nothing the docs already say.

This needs a small code change: a setting that mounts one help site's `/feedback` pages on the app's own host, and
makes that site's public origin the app's. Customers keep their own sites on their own hosts.

## Proposal: the console on `app.mocco.club`

Splitting the console onto its own host is the common pattern (marketing and content on `www`, the product on
`app`):

| Host | Serves |
| --- | --- |
| `www.mocco.club` | Landing, `/docs`, `/feedback/…` (board, roadmap, changelog), later help and status links. Indexed. |
| `app.mocco.club` | The console: sign-in, workspaces, account. `noindex`. |

- **Separation.** Text written by Mocco's users (posts, comments) is served on `www`; signed-in sessions live on
  `app`. A mistake in rendering user content can't reach the console's origin.
- **Search.** The console has nothing to index; keeping it off `www` keeps `www` clean.
- **Cost.** One Vercel project and one deployment answer both hosts; `proxy.ts` sends console paths to `app` and
  public paths to `www` (308).

What moving the console touches, and how each is handled:

1. **Sign-in.** `SERVICE_DOMAIN` and the trusted auth origins move to `app.mocco.club`. Sessions are host-only cookies,
   so people sign in once more. Both hosts are trusted during the switch.
2. **MCP OAuth.** The issuer and `.well-known` metadata follow `SERVICE_DOMAIN`; connected agent clients may have to
   connect again. Announce it.
3. **APIs keep working on both hosts.** Devices and SDKs call `www.mocco.club/api/ext/v1/…`, and the GitHub App's
   webhook and callback URLs point at `www`. `/api/*` answers on both hosts with no redirect; `api.mocco.club`
   (`PUBLIC_API_DOMAIN`) is the long-term home for the public API.
4. **Old links.** Console paths on `www` (`/workspaces/…`, `/auth/…`) redirect to `app`, so bookmarks and links in old
   mail keep working.

This is a separate change with its own PR and a planned production switch; it doesn't block the subpath above.

## Later: status page and customer help sites

- **`status.mocco.club`.** A status page must stay up while Mocco is down, so it's a static snapshot on object storage
  behind a CDN, never served by the app ([ADR 0028](../adr/0028-status-pages-are-static-snapshots.md)). Production
  has the bucket but no CDN that maps a host to `pub/status/<slug>/`. It waits for one (CloudFront, or R2 with a
  Cloudflare custom domain).
- **Customers' help sites.** Customers' sites belong on their own domains (`help.customer.com`), which is also best for
  their search. The default `<site>.<HELP_SITES_DOMAIN>` host needs a wildcard certificate (Vercel's nameservers for
  that zone) and is better on a registrable domain of its own, so customer content never shares Mocco's. That is a
  separate decision, together with [ADR draft #432](https://github.com/fi-workers/mocco/pull/432) on custom domains.

## Order

1. **Mount Mocco's board on `www`.** The code change above, then in production: the Mocco workspace's "Mocco"
   project with the feedback product on, its help site `mocco` (the board needs one) and the `ideas` board.
2. **The console widgets.** The What's new badge and the feedback sheet in the console header, fed by that project
   (its own PR). Needs a publishable key with `feedback:read` and `feedback:write`, the console's web origin, and the
   project's identity secret in the production env.
3. **Email.** Pick a provider (any SMTP), add its SPF and DKIM records in Cloudflare, and set `EMAIL_DRIVER=smtp`,
   `EMAIL_FROM` (for example `Mocco <noreply@mocco.club>`) and `EMAIL_SMTP_URL`. This turns on votes by email, status
   mail, status subscribers and email notifications for every customer, not only for Mocco.
4. **The console on `app.mocco.club`**, if adopted (above).
5. **Support inbox.** The messenger in the console for Mocco's own users, and conversations converted into board
   posts. The web console needs a messenger UI first.
6. **Ship on release.** Posts on Mocco's board are shipped when a release contains their linked PR. Mocco deploys
   through Vercel's Git integration, not through Mocco runs, so this needs either Mocco's own deploys to go through a
   Mocco pipeline with a gate, or a Vercel deployment event that becomes a release.
7. **Status page and customer help hosts**, as above. Then the docs sync.

## Who does what

| Step | Owner |
| --- | --- |
| Code: mount a site on the app host; console widgets; host split | Agents, as PRs |
| Production setup of the Mocco project, help site and board | The team, in the console (or an agent over MCP with someone's sign-in) |
| Email provider, its DNS records and the `EMAIL_*` env | The team picks the provider; then env and docs |
| `app.mocco.club` DNS and the production switch | The team (DNS) and a planned switch |
| AI Gateway key for embeddings and translation | The team |
| GitHub App: Issues read and the `issues` event (for GitHub links) | The team |

A first attempt on 2026-10-17 added `help.mocco.club` to the Vercel project with `HELP_CUSTOM_DOMAINS`; both were
removed the same day when the subpath was chosen.

## Risks

- **Self-dependency.** If Mocco is down, so are its board and changelog. That's acceptable for ideas and release notes,
  not for status, which is why status is static and separate.
- **User content on the app's host.** Until the console moves to `app`, Mocco's board on `www` shares the host with
  signed-in sessions. Board content is rendered as text (no links or images from posts), which keeps the risk low; the
  host split removes it.
- **One production.** Mocco's own project lives in the same database as customers'. It gets no special access; it's
  just another workspace.
