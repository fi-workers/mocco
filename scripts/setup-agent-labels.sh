#!/usr/bin/env bash
# Creates the state labels for agent orchestration. Existing labels only get their color and description updated.
# Guide: docs/guides/agent-orchestration.md
set -euo pipefail

create() {
  gh label create "$1" --color "$2" --description "$3" --force
}

create "agent:ready"        "0e8a16" "Spec is complete; an agent may pick it up"
create "agent:in-progress"  "fbca04" "An agent is working on it"
create "agent:verifying"    "1d76db" "Verification gate running"
create "agent:human-review" "5319e7" "PR awaiting human review"
create "agent:blocked"      "d93f0b" "Stopped on a spec or permission problem; see the issue comments"
create "agent:rework"       "e99695" "Review asked for changes; the agent works on it again"
create "sentry"             "362d59" "Issue created by Sentry triage"
