#!/bin/bash
# Wrapper for macOS Shortcuts / launchd — logs to /tmp/monthly-cliq-worker.log
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_FILE="${MONTHLY_CLIQU_LOG_FILE:-/tmp/monthly-cliq-worker.log}"

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
  echo "trigger=scripts/run-monthly-cliq.sh"
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
  "$NODE" workers/monthly-cliq/index.js
  EXIT=$?
  echo "----------------------------------------"
  echo "========== RUN END exit=${EXIT} $(date) =========="
  exit "$EXIT"
} >>"$LOG_FILE" 2>&1
