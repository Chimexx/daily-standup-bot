#!/bin/bash
# Wrapper for macOS Shortcuts / launchd — every run appends to a log file you can inspect.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="${STANDUP_LOG_FILE:-/tmp/daily-standup-bot-shortcut.log}"

if [[ -x /opt/homebrew/opt/node@20/bin/node ]]; then
  NODE="/opt/homebrew/opt/node@20/bin/node"
elif [[ -x /opt/homebrew/bin/node ]]; then
  NODE="/opt/homebrew/bin/node"
else
  NODE="$(command -v node || true)"
fi

{
  echo ""
  echo "========== RUN START $(date) =========="
  echo "trigger=run-standup.sh (Shortcuts / manual)"
  echo "cwd=${SCRIPT_DIR}"
  echo "node=${NODE:-MISSING}"
  echo "log=${LOG_FILE}"
  echo "----------------------------------------"

  if [[ -z "${NODE:-}" || ! -x "$NODE" ]]; then
    echo "ERROR: node not found."
    echo "========== RUN END exit=127 $(date) =========="
    exit 127
  fi

  cd "$SCRIPT_DIR" || exit 1
  "$NODE" index.js
  EXIT=$?
  echo "----------------------------------------"
  echo "========== RUN END exit=${EXIT} $(date) =========="
  exit "$EXIT"
} >>"$LOG_FILE" 2>&1
