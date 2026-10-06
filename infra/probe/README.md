# Hosted probe locations

Mocco's hosted locations are the same `@mocco/probe` agent a customer runs at a private location
([ADR 0027](../../docs/adr/0027-status-probes-are-pull-based-agents.md)), deployed as one small Fly.io machine per
region. Nothing in the backend knows about Fly: a hosted location is a row in `mocco_status_locations` with
`kind = 'hosted'` and no workspace, plus an agent that polls with that row's token. This directory is config only;
nothing here deploys itself.

## Regions

| Location code | Name       | Where                                      | Host                                                                                            |
| ------------- | ---------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `fra`         | Frankfurt  | Fly `fra`                                  | `mocco-probe-fra`                                                                               |
| `iad`         | Virginia   | Fly `iad`                                  | `mocco-probe-iad`                                                                               |
| `sjc`         | California | Fly `sjc`                                  | `mocco-probe-sjc`                                                                               |
| `sin`         | Singapore  | Fly `sin`                                  | `mocco-probe-sin`                                                                               |
| `nrt`         | Tokyo      | Fly `nrt`                                  | `mocco-probe-nrt`                                                                               |
| `icn`         | Seoul      | Another provider (Fly has no Seoul region) | Vultr Seoul or AWS Lightsail `ap-northeast-2`, running the same image with the same environment |

A monitor that runs at several of them is decided by quorum, so one region's network trouble never takes it down ([status reference](../../docs/reference/status.md#verdicts-and-the-state-machine)).

## Adding a region

1. **Create the location row and its token.** Shared locations aren't created from the console. Generate a token
   and its hash the same way `location-token.ts` does:

   ```bash
   node -e "const c=require('node:crypto');const t='mpl_'+c.randomBytes(32).toString('base64url');console.log(t);console.log(c.createHash('sha256').update(t).digest('hex'))"
   ```

   Keep the first line (the token) for step 3, and insert the second (the hash) with a migration-capable role on the
   production database:

   ```sql
   INSERT INTO mocco_status_locations (code, name, kind, token_hash)
   VALUES ('fra', 'Frankfurt', 'hosted', '<sha256 hex>');
   ```

   The row has no `workspace_id`, so every workspace can assign it to monitors. To replace a token later, update
   `token_hash` the same way; the old token stops working at once. Setting `disabled_at` takes the location out of
   new monitors and stops its agent (its lease calls get `401`).

2. **Create the app** (once per region):

   ```bash
   fly apps create mocco-probe-fra
   ```

3. **Set its token:**

   ```bash
   fly secrets set --app mocco-probe-fra MOCCO_PROBE_TOKEN=mpl_...
   ```

4. **Deploy** from the repository root, so the image builds with the root as its context:

   ```bash
   fly deploy . --config infra/probe/fly.toml --app mocco-probe-fra --primary-region fra
   ```

   `fly.toml` sets `MOCCO_URL`, `MOCCO_PROBE_HOSTED=true` (the address block list for hosted probes) and a
   concurrency of 50, and opens no service: the agent only calls out over HTTPS. One machine per region is enough;
   a second one with the same token splits that location's work.

5. **Check it is polling:** the location's `last_seen_at` and `agent_version` update every 15 to 30 seconds, and the
   console's Locations view shows it as seen.

For the Seoul location, run the image on the other provider with the same three variables and
`--restart unless-stopped`, as in the private-location `docker run` the console shows.

## When a hosted location goes silent

The `status.evaluate` job marks a location in use silent after three minutes without a poll or heartbeat
(`unhealthy_since`). Rounds stop waiting for it and count it as no data, so the other regions decide. A hosted
location's alert is an error log line, `[status] shared location silent`, with its code, never a customer's
notification; route that line to the operator's log alerting. `[status] shared location back` follows when it polls
again.
