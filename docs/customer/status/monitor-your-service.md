---
title: Monitor your service
description: Run the Mocco probe at a private location, create an HTTP or TCP monitor that checks your service every minute, and see what happens when it fails — the components it changes, the draft incident it opens and follows, the alerts it sends — and how Mocco watches your monitors right after a deploy.
type: guide
status: active
created: 2026-10-05
updated: 2026-10-05
confidence: high
owner: andrea
tags: [customer, status, monitors, probe, guide]
related:
  - ./status-page.md
  - ../../reference/status.md
---

# Monitor your service

A **monitor** checks your service on a schedule, an HTTP request or a TCP connection, and tells your status page when it stops working. Checks run at **probe locations**: a probe is a small agent you run on a machine that can reach your service. It asks Mocco for work and reports what it saw, so it needs no inbound port.

You need a status page with components first ([Run a status page](./status-page.md)): a monitor changes what its components show.

## 1. Get a probe location

Locations belong to the workspace, so every project can use them.

- **A private location** is a probe you run yourself. Creating one in the console comes next; until then an owner or admin creates it with the `status.createLocation` call, which returns the location's **token** once. Keep it: Mocco stores only a hash of it.
- **This server**: a self-hosted Mocco on one machine can run the probe inside the server instead (`STATUS_PROBE_EMBEDDED=true`), and every workspace on it can use that location.

## 2. Run the probe

On a machine that can reach the services you want to check and can make outbound HTTPS calls to Mocco, run the probe with the location's token:

```bash
docker run -d --restart unless-stopped \
  -e MOCCO_URL=https://www.mocco.work -e MOCCO_PROBE_TOKEN=mpl_... ghcr.io/fi-workers/mocco-probe
# or, with Node 22
MOCCO_URL=https://www.mocco.work MOCCO_PROBE_TOKEN=mpl_... npx @mocco/probe
```

Until the package and image are published, run it from a checkout of Mocco: `yarn workspace @mocco/probe build`, then `node packages/probe/dist/cli.js` with the same two variables. Two probes with one token share that location's work. A probe whose token is wrong, replaced or disabled exits with an error.

## 3. Create a monitor

Open **Monitors** and choose **New monitor**.

![A new HTTP monitor checking the health endpoint from the office network, with REST API in a major outage while it is down](./images/new-monitor.png)

- **Check**: **HTTP** sends a request to a URL with a method (GET, HEAD or POST, with a body for POST); **TCP** opens a connection to a host and port.
- **Expected status codes**: the answers that pass, such as `200, 204`. Leave it empty to accept any 2xx.
- **Keyword**: optionally, the body must contain a word, or must not.
- **Slow above (ms)**: optionally, an answer slower than this still passes but makes the monitor **degraded**.
- **Timeout**: how long one check may take, up to 30 seconds.
- **Every (s)**: how often it runs, at least every 60 seconds.
- **Down after** and **Up after**: how many rounds in a row must fail before the monitor is down, and pass before it is up again. The default is 2, so one bad answer doesn't page anyone.
- **Locations**: where it runs. With several, **Locations that must agree** decides how many of those that reported must fail (or pass) for the round to count; a location that sent nothing never counts as a failure.
- **While down**: what each component shows while the monitor is down, or **Not affected**.
- **When it goes down**: open no incident, a **draft** incident (the default), or a **published** one.

A new monitor is **Pending** until its first round, which runs at once.

![The project's monitors with their state, target and components](./images/monitors.png)

## 4. What happens when it fails

When a round fails, the monitor is **Suspect** and checks again right away. If it is still failing after **Down after** rounds, it is **Down**:

- the components you linked show the impact you chose, on the console and on the public page;
- an incident opens: "API health is down", **Investigating**, on the page holding most of those components. A **draft** stays in the console and never reaches the public page; review it and post your own updates. A published incident opens as a draft while a maintenance window covers the components;
- Mocco sends a **Down** alert (`status.monitor.down`) through your [notification rules](../notifications/mocco-events.md). The alert names only the host and port, never the URL's path, query or credentials.

![The monitor down after two failed rounds, with the draft incident it opened](./images/monitor-down.png)

When checks pass again the monitor is **Recovering**, and the incident gets a **Monitoring** update. After **Up after** passing rounds it is **Up**: the incident is **Resolved**, the components go back, and a **Recovered** alert is sent. A false alarm (Suspect, then Up) sends nothing. A slow answer makes it **Degraded** and sends a **Degraded** alert.

The monitor's page lists its latest rounds and every state change. Use **Pause** to stop checking it (for example while you move the service) and **Resume** to start again; **Edit** changes its settings and keeps its state.

![The monitor's rounds and state changes, from up through suspect, down and recovering back to up](./images/monitor-recovered.png)

## 5. After a deploy

When a run of a repository linked to the project is released (it succeeded after passing a gate), Mocco **watches** the project's monitors for 15 minutes: they check every 30 seconds instead of every minute. The monitor's page says which run it is watching after, and until when.

![A monitor watching after a deploy, checking every 30 seconds until the watch ends](./images/deploy-watch.png)

If a monitor goes down during the watch, the incident it opens says it started failing within minutes of a deploy, and the run is listed as **Suspected** under the incident's **Recent deploys**. The run's own timeline records the failed check too. The run itself isn't changed or rolled back.

A pipeline step can also ask for a round right away with `POST /v1/monitors/{id}/check` and a secret key with `status:write`.

## What gets recorded

Creating, editing, pausing, resuming and deleting monitors, and creating, rotating and disabling locations, are written to the workspace's [audit log](../start/audit-log.md), as are the incidents a monitor opens and updates.
