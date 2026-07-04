---
title: .mocco.yml file format spec (draft v1)
type: reference
status: draft
created: 2026-06-30
updated: 2026-06-30
confidence: medium
owner: andrea
code_refs: []
tags: [reference, schema, config, mocco-yml]
related:
  - ../adr/0003-core-model-is-pause-resume-gates-no-env.md
  - ../concepts/glossary.md
  - ./mocco.schema.json
---

# `.mocco.yml` file format spec (draft v1)

> The `.mocco.yml` at the repo root is Mocco's source of truth declaring the **pipeline + gates**.
> **This is not a GitHub Actions workflow file.** GitHub workflows (`.github/workflows/*.yml`) are owned by the team, and we only **reference** them from a step.
> Validation schema: [`mocco.schema.json`](./mocco.schema.json) (JSON Schema draft 2020-12).

## Full example

```yaml
version: 1
pipeline: deploy

steps:                                  # ordered list. each item is a step or a gate
  - run: build
    executor: github-actions            # executor adapter
    with: { workflow: build.yml, ref: main }

  - run: deploy-staging
    executor: github-actions
    with: { workflow: deploy.yml }

  - gate: approve                        # pause/resume gate
    resume:                              # AND — count people from each role must resume
      - { role: sre, count: 2 }
      - { role: security, count: 1 }
    prevent_self: true                   # the author/committer/triggerer can't resume their own (default true)
    reason_required: true

  - run: deploy-prod
    executor: github-actions
    with: { workflow: deploy.yml }
    credential:                          # the credentials this step needs
      provider: aws-oidc
      role: deploy-prod
      ttl: 15m                           # the broker issues only to a run whose preceding gate was resumed

concurrency: { group: deploy, mode: oldest_first }
safety:      { prevent_outdated: reject }
preconditions:
  require_merged_to: main
  require_status_checks: [ci/test, ci/lint]
  require_code_owner_review: true
audit: { hash_chain: true }
```

## Fields

### Top level
| Key | Type | Required | Description |
|---|---|---|---|
| `version` | int | ✓ | Format version. Currently `1` |
| `pipeline` | string | ✓ | Pipeline name |
| `steps` | array | ✓ | **Ordered** list of step/gate items (≥1) |
| `concurrency` | object |  | Concurrency — `group`, `mode` |
| `safety` | object |  | `prevent_outdated` |
| `preconditions` | object |  | Verify GitHub facts before the pipeline starts |
| `audit` | object |  | `hash_chain` |

### step item (identified by the `run` key)
| Key | Type | Required | Description |
|---|---|---|---|
| `run` | string | ✓ | Step name (label). Not a type |
| `executor` | string | ✓ | Executor adapter id (`github-actions`, etc.) |
| `with` | object |  | Adapter-specific options (free-form). GitHub: `workflow`, `ref` |
| `credential` | object |  | The credentials this step receives — `provider`, `role`, `ttl`. Broker issues only when the preceding gate is resumed |

### gate item (identified by the `gate` key)
| Key | Type | Required | Description |
|---|---|---|---|
| `gate` | string | ✓ | Gate name |
| `resume` | array | ✓ | Resume requirements. Each element `{ role, count }`. The array is **AND**-combined |
| `prevent_self` | bool |  | Default `true` |
| `reason_required` | bool |  | Default `false` |

### enum
- `concurrency.mode`: `oldest_first` \| `newest_first` \| `newest_ready_first` \| `unordered`
- `safety.prevent_outdated`: `reject` \| `skip` \| `off`
- `credential.provider`: `aws-oidc` \| `gcp-oidc` \| `azure-oidc` \| `vault` (adapter extension)

## Design decisions (draft, subject to change)

1. **roles don't carry membership in the file.** `resume` references role **names only**. The role→people mapping is managed in Access (a separate store) — membership changes often and isn't subject to code review.
2. **credentials are declared on the step** (need), **the gate controls the flow**, **the broker enforces** (not issued if the preceding gate isn't resumed). → expresses "the gate guards the credentials" as data. Note: [ADR 0003](../adr/0003-core-model-is-pause-resume-gates-no-env.md) words this as the credential "binding to the gate" — same enforcement semantics, different placement in the file format; to be reconciled when the governance phase implements the broker (open question 2).
3. **executor is specified per step.** All GitHub-specific options go in `with`. The core schema has no GitHub words (`workflow` is an adapter key inside `with`).
4. **No env key** (ADR 0003).

## Open questions

- [ ] Whether to allow specifying a default `executor` once at the top level
- [ ] The gate's `credential` vs the step's `credential` — whether to unify on one side
- [ ] The format of the org-level override file (separate repo) — only monotonically hardens the repo `.mocco.yml`
