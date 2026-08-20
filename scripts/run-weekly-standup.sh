#!/bin/bash
# Wrapper for macOS Shortcuts / launchd — logs to /tmp/weekly-standup-bot-shortcut.log
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_FILE="${WEEKLY_STANDUP_LOG_FILE:-/tmp/weekly-standup-bot-shortcut.log}"

if [[ -x /opt/homebrew/opt/node@20/bin/node ]]; then
  NODE="/opt/homebrew/opt/node@20/bin/node"
elif [[ -x /opt/homebrew/bin/node ]]; then
  NODE="/opt/homebrew/bin/node"
elif [[ -x /Applications/ServBay/bin/node ]]; then
  NODE="/Applications/ServBay/bin/node"
else
  NODE="$(command -v node || true)"
fi

{
  echo ""
  echo "========== RUN START $(date) =========="
  echo "trigger=scripts/run-weekly-standup.sh"
  echo "cwd=${PROJECT_ROOT}"
  echo "node=${NODE:-MISSING}"
  echo "log=${LOG_FILE}"
  echo "----------------------------------------"

  if [[ -z "${NODE:-}" || ! -x "$NODE" ]]; then
    echo "ERROR: node not found."
    echo "========== RUN END exit=127 $(date) =========="
    exit 127
  fi

  cd "$PROJECT_ROOT" || exit 1
  # Shortcuts controls the schedule — don't block manual/test runs on non-Tuesdays.
  export WEEKLY_STANDUP_FORCE=1
  "$NODE" workers/weekly-standup/index.js
  EXIT=$?
  echo "----------------------------------------"
  echo "========== RUN END exit=${EXIT} $(date) =========="
  exit "$EXIT"
} >>"$LOG_FILE" 2>&1
