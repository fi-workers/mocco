# @mocco/probe

## 0.1.0

### Minor Changes

- f910a30: First release of `@mocco/probe`, the status page's probe agent. It leases the rounds due at its location from Mocco, runs HTTP checks (expected status, keyword in the first megabyte, latency threshold, timeout, up to five redirects, phase timings, certificate expiry) and TCP connect checks, and posts the results in batches. Run it with `MOCCO_URL` and a location token in `MOCCO_PROBE_TOKEN`; `MOCCO_PROBE_HOSTED=true` makes it refuse private, loopback, link-local and metadata addresses, checked on every connection and redirect.
- f82bc98: Adds `@mocco/probe/create-agent`, the agent with its checks for a host that brings its own API. A Mocco server uses it to run the embedded probe (`STATUS_PROBE_EMBEDDED`); the `mocco-probe` bin is built on the same function.
