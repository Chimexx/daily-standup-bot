#!/bin/bash
# Backward-compatible wrapper for macOS Shortcuts — see scripts/run-weekly-standup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "${ROOT}/scripts/run-weekly-standup.sh" "$@"
