---
'@mocco/probe': minor
---

First release of `@mocco/probe`, the status page's probe agent. It leases the rounds due at its location from Mocco, runs HTTP checks (expected status, keyword in the first megabyte, latency threshold, timeout, up to five redirects, phase timings, certificate expiry) and TCP connect checks, and posts the results in batches. Run it with `MOCCO_URL` and a location token in `MOCCO_PROBE_TOKEN`; `MOCCO_PROBE_HOSTED=true` makes it refuse private, loopback, link-local and metadata addresses, checked on every connection and redirect.
