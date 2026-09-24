#!/usr/bin/env bash
# Installs a launchd job that runs the orchestrator every morning (daily: Sentry triage → issue work).
#   scripts/agents/install-launchd.sh            install (default 08:00)
#   scripts/agents/install-launchd.sh 7 30       install at 07:30
#   scripts/agents/install-launchd.sh --uninstall
# Each run resets a dedicated control worktree to origin/<default branch> and calls the orchestrator.mjs there,
# so only merged code runs, regardless of the branch checked out in your working copy.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# Read owner/repo from the origin URL (git@github.com:owner/name.git, https://github.com/owner/name)
SLUG="$(git -C "$REPO" remote get-url origin | sed -E 's#(\.git)?$##; s#^.*[:/]([^/]+/[^/]+)$#\1#')"
OWNER="${SLUG%%/*}"
NAME="${SLUG##*/}"
LABEL="com.$OWNER.$NAME.agents"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/agents/$NAME"
# WORKFLOW.md's workspace.root must be ~/agent-workspaces/<repo name>
CONTROL="$HOME/agent-workspaces/$NAME/control"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed: $PLIST"
  exit 0
fi

HOUR="${1:-8}"
MINUTE="${2:-0}"
NODE="$(command -v node)"
PATH_VALUE="$(dirname "$NODE"):$(dirname "$(command -v claude)"):$(dirname "$(command -v gh)"):$(dirname "$(command -v sentry)"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")" "$(dirname "$CONTROL")"
BASE="$(git -C "$REPO" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
BASE="${BASE:-main}"
git -C "$REPO" fetch -q origin "$BASE"
if [[ ! -d "$CONTROL" ]]; then
  git -C "$REPO" worktree add --detach "$CONTROL" "origin/$BASE"
fi
RUN="cd '$CONTROL' && git fetch -q origin $BASE && git checkout -q --detach --force origin/$BASE && exec node scripts/agents/orchestrator.mjs daily"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>$RUN</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH_VALUE</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/launchd.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/launchd.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
printf 'Installed: daily at %02d:%02d · %s\nLogs: %s\nRun once now: launchctl kickstart gui/%s/%s\n' \
  "$HOUR" "$MINUTE" "$CONTROL" "$LOG_DIR" "$(id -u)" "$LABEL"
